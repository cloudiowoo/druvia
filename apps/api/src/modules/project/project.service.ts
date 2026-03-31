import { query, queryOne } from '../../db/index.js';
import { generateProjectId } from '@druvia/shared';
import type { Project, CreateProjectInput, UpdateProjectInput } from '@druvia/shared';
import * as schemaService from '../schema/schema.service.js';
import * as tenantService from '../tenant/tenant.service.js';
import * as environmentService from '../environment/environment.service.js';
import * as dbCredentialsService from './db-credentials.service.js';
import { hasuraMetadataRequest } from '../realtime/realtime.service.js';
import { validateAlias } from '../../lib/validation.js';
import { createApiLogger } from '../../lib/logger.js';
import { getDefaultStorageAdapter, type StorageAdapter } from '../../adapters/storage/index.js';

const logger = createApiLogger({ module: 'project' });

// Database row type (snake_case)
interface ProjectRow {
  id: number;
  project_id: string;
  tenant_id: string;
  alias: string;
  name: string;
  schema_name: string | null;
  settings: Record<string, unknown>;
  status: string;
  created_at: Date;
  updated_at: Date;
}

// Convert database row to Project interface
function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    projectId: row.project_id,
    tenantId: row.tenant_id,
    alias: row.alias,
    name: row.name,
    schemaName: row.schema_name,
    settings: row.settings,
    status: row.status as Project['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  // 验证项目别名
  validateAlias(input.alias, '项目别名');

  const projectId = generateProjectId();

  // 获取租户信息
  const tenant = await tenantService.getTenantById(input.tenantId);
  if (!tenant) {
    throw new Error('Tenant not found');
  }

  // 创建项目记录
  const row = await queryOne<ProjectRow>(
    `INSERT INTO druvia_projects (project_id, tenant_id, alias, name)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [projectId, input.tenantId, input.alias, input.name]
  );

  if (!row) {
    throw new Error('Failed to create project');
  }

  // 自动创建项目 Schema
  const schemaName = await schemaService.createProjectSchema(
    input.tenantId,
    tenant.alias,
    projectId,
    input.alias
  );

  // 返回更新后的项目（包含 schema_name）
  return {
    ...toProject(row),
    schemaName,
  };
}

export async function getProjectById(projectId: string): Promise<Project | null> {
  const row = await queryOne<ProjectRow>(
    'SELECT * FROM druvia_projects WHERE project_id = $1',
    [projectId]
  );
  return row ? toProject(row) : null;
}

export async function getProjectByAlias(tenantId: string, alias: string): Promise<Project | null> {
  const row = await queryOne<ProjectRow>(
    'SELECT * FROM druvia_projects WHERE tenant_id = $1 AND alias = $2',
    [tenantId, alias]
  );
  return row ? toProject(row) : null;
}

export async function listProjects(tenantId: string, limit = 50, offset = 0): Promise<Project[]> {
  const rows = await query<ProjectRow>(
    'SELECT * FROM druvia_projects WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [tenantId, limit, offset]
  );
  return rows.map(toProject);
}

export async function updateProject(projectId: string, input: UpdateProjectInput): Promise<Project | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(input.name);
  }
  if (input.settings !== undefined) {
    updates.push(`settings = COALESCE(settings, '{}'::jsonb) || $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(input.settings));
  }
  if (input.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(input.status);
  }

  if (updates.length === 0) {
    return getProjectById(projectId);
  }

  values.push(projectId);
  const row = await queryOne<ProjectRow>(
    `UPDATE druvia_projects SET ${updates.join(', ')} WHERE project_id = $${paramIndex} RETURNING *`,
    values
  );

  return row ? toProject(row) : null;
}

export async function deleteProject(projectId: string): Promise<boolean> {
  // 获取项目信息
  const project = await getProjectById(projectId);
  if (!project) {
    return false;
  }

  try {
    // 1. 先删除项目数据库用户，避免后续失败时出现“项目仍在但 schema 已被删掉”的半删除状态
    await dbCredentialsService.dropProjectDbUser(projectId);

    // 2. 获取所有环境（不含主 schema）
    const environments = await environmentService.listEnvironments(projectId);

    // 3. 从 Hasura 中 untrack 所有环境的表
    for (const env of environments) {
      await untrackSchemaTablesFromHasura(env.schemaName);
    }

    // 4. 删除所有环境的 Schema
    for (const env of environments) {
      await schemaService.dropSchema(env.schemaName);
    }

    // 5. 删除项目主 Schema（不在 environments 表中）
    if (project.schemaName) {
      await untrackSchemaTablesFromHasura(project.schemaName);
      await schemaService.dropSchema(project.schemaName);
    }

    // 6. 删除物理存储副产物，避免在前置关键步骤失败时先丢文件
    await cleanupProjectPhysicalArtifacts(project);

    // 7. 删除项目记录（会级联删除 API 密钥和环境记录）
    const rows = await query<{ project_id: string }>(
      'DELETE FROM druvia_projects WHERE project_id = $1 RETURNING project_id',
      [projectId]
    );

    return rows.length > 0;
  } catch (error) {
    logger.error('failed to delete project', { projectId }, error);
    throw error;
  }
}

async function cleanupProjectPhysicalArtifacts(project: Project): Promise<void> {
  const storage = getDefaultStorageAdapter();

  await deleteStoragePrefix(storage, `${project.projectId}/`);
  await deleteStoragePrefix(storage, `${project.tenantId}/${project.projectId}/`);

  const backups = await query<{ storage_key: string }>(
    `SELECT storage_key
     FROM druvia_backups
     WHERE project_id = $1`,
    [project.projectId]
  );

  for (const backup of backups) {
    await storage.delete(backup.storage_key);
  }
}

async function deleteStoragePrefix(storage: StorageAdapter, prefix: string): Promise<void> {
  const filePaths = await storage.list(prefix);
  for (const filePath of filePaths) {
    await storage.delete(filePath);
  }
}

// 从 Hasura 中 untrack Schema 的所有表
async function untrackSchemaTablesFromHasura(schemaName: string): Promise<void> {
  try {
    // 获取 Schema 中的所有表
    const tablesResult = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '_meta_%'`,
      [schemaName]
    );

    // Untrack 每个表
    for (const row of tablesResult) {
      try {
        await hasuraMetadataRequest('pg_untrack_table', {
          source: 'default',
          table: { schema: schemaName, name: row.table_name },
          cascade: true,
        });
      } catch (error) {
        // 忽略表未被追踪的错误
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!errorMsg.includes('not tracked') && !errorMsg.includes('does not exist')) {
          logger.warn('failed to untrack table from hasura', {
            schemaName,
            tableName: row.table_name,
          }, error);
        }
      }
    }
  } catch (error) {
    logger.warn('failed to untrack tables from schema', { schemaName }, error);
  }
}

export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
}

// 允许的只读 SQL 命令
const ALLOWED_COMMANDS = ['SELECT', 'WITH'];

export async function executeQuery(projectId: string, sql: string): Promise<QueryResult> {
  // 获取项目信息
  const project = await getProjectById(projectId);
  if (!project || !project.schemaName) {
    throw new Error('Project not found');
  }

  // 安全检查：只允许 SELECT 查询
  const trimmedSql = sql.trim().toUpperCase();
  const firstWord = trimmedSql.split(/\s+/)[0];
  if (!ALLOWED_COMMANDS.includes(firstWord)) {
    throw new Error('Only SELECT queries are allowed');
  }

  // 设置 search_path 到项目 schema
  const client = await import('../../db/index.js').then(m => m.pool.connect());
  try {
    await client.query(`SET search_path TO ${project.schemaName}, public`);
    const result = await client.query(sql);

    // 获取列信息
    const columns = result.fields.map(field => ({
      name: field.name,
      type: getTypeName(field.dataTypeID),
    }));

    return {
      rows: result.rows,
      columns,
      rowCount: result.rowCount || 0,
    };
  } finally {
    // 重置 search_path，避免污染连接池中的其他连接
    await client.query('RESET search_path').catch(() => {});
    client.release();
  }
}

// PostgreSQL OID 到类型名称的映射
function getTypeName(oid: number): string {
  const typeMap: Record<number, string> = {
    16: 'boolean',
    20: 'bigint',
    21: 'smallint',
    23: 'integer',
    25: 'text',
    700: 'real',
    701: 'double precision',
    1043: 'varchar',
    1082: 'date',
    1114: 'timestamp',
    1184: 'timestamptz',
    2950: 'uuid',
    3802: 'jsonb',
  };
  return typeMap[oid] || 'unknown';
}

// 允许的 DDL/DML 命令
const DDL_COMMANDS = [
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'INSERT', 'UPDATE', 'DELETE',
  'SELECT', 'WITH',
  'COMMENT',
];

// 危险命令黑名单
const DANGEROUS_PATTERNS = [
  // Schema/Database 操作
  /DROP\s+SCHEMA/i,
  /CREATE\s+SCHEMA/i,
  /ALTER\s+SCHEMA/i,
  /DROP\s+DATABASE/i,
  /ALTER\s+DATABASE/i,
  // Role/User 操作
  /DROP\s+(ROLE|USER)/i,
  /CREATE\s+(ROLE|USER)/i,
  /ALTER\s+(ROLE|USER)/i,
  /SET\s+ROLE/i,
  /RESET\s+ROLE/i,
  // 权限操作
  /GRANT\s/i,
  /REVOKE\s/i,
  // 函数/过程/触发器
  /CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)/i,
  /CREATE\s+TRIGGER/i,
  /SECURITY\s+DEFINER/i,
  // 扩展
  /CREATE\s+EXTENSION/i,
  /DROP\s+EXTENSION/i,
  // 文件操作
  /COPY\s+(TO|FROM)/i,
  /pg_read_file/i,
  /pg_ls_dir/i,
  // 消息
  /LISTEN\s/i,
  /NOTIFY\s/i,
  // 加载
  /LOAD\s/i,
  // search_path 操作
  /SET\s+search_path/i,
  /RESET\s+search_path/i,
  // RLS 策略
  /(CREATE|ALTER|DROP)\s+POLICY/i,
  // 预处理语句（可绕过过滤）
  /\bPREPARE\s/i,
  /\bEXECUTE\s/i,
  // 系统 schema 访问
  /\bpublic\s*\./i,
  /\bpg_catalog\s*\./i,
  /\binformation_schema\s*\./i,
  /\bdruvia_/i,
];

// 移除 SQL 注释（处理嵌套注释）
function stripSqlComments(sql: string): string {
  // 规范化 Unicode，移除零宽字符
  let result = sql.normalize('NFKC');
  result = result.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // 移除单行注释
  result = result.replace(/--[^\n\r]*/g, '');

  // 移除多行注释（迭代处理嵌套）
  let prev = '';
  while (prev !== result) {
    prev = result;
    result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  }

  return result.trim();
}

export async function executeDdl(projectId: string, sql: string): Promise<QueryResult> {
  const project = await getProjectById(projectId);
  if (!project || !project.schemaName) {
    throw new Error('Project not found');
  }

  // 先移除注释再检查
  const cleanedSql = stripSqlComments(sql);
  const upperSql = cleanedSql.toUpperCase();
  const firstWord = upperSql.split(/\s+/)[0];

  if (!firstWord) {
    throw new Error('SQL 语句不能为空');
  }

  // 检查是否是允许的命令
  if (!DDL_COMMANDS.includes(firstWord)) {
    throw new Error(`不支持的 SQL 命令: ${firstWord}`);
  }

  // 检查危险模式（对清理后的 SQL 检查）
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cleanedSql)) {
      throw new Error('不允许执行此类操作');
    }
  }

  const client = await import('../../db/index.js').then(m => m.pool.connect());
  try {
    // 设置查询超时 30 秒
    await client.query('SET statement_timeout = 30000');
    // 使用 format 函数安全设置 search_path
    const setPathResult = await client.query(
      `SELECT format('SET search_path TO %I', $1::text) as sql`,
      [project.schemaName]
    );
    await client.query(setPathResult.rows[0].sql);

    const result = await client.query(cleanedSql);

    const columns = result.fields?.map(field => ({
      name: field.name,
      type: getTypeName(field.dataTypeID),
    })) || [];

    return {
      rows: result.rows || [],
      columns,
      rowCount: result.rowCount || 0,
    };
  } finally {
    // 重置 search_path，避免污染连接池中的其他连接
    await client.query('RESET search_path').catch(() => {});
    await client.query('RESET statement_timeout').catch(() => {});
    client.release();
  }
}
