import { query, queryOne } from '../../db/index.js';
import { generateProjectId } from '@druvia/shared';
import type { Project, CreateProjectInput, UpdateProjectInput } from '@druvia/shared';
import * as schemaService from '../schema/schema.service.js';
import * as tenantService from '../tenant/tenant.service.js';
import { validateAlias } from '../../lib/validation.js';

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
    updates.push(`settings = $${paramIndex++}`);
    values.push(input.settings);
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

  // 删除项目 Schema（如果存在）
  if (project.schemaName) {
    await schemaService.dropSchema(project.schemaName);
  }

  // 删除项目记录
  const rows = await query<{ project_id: string }>(
    'DELETE FROM druvia_projects WHERE project_id = $1 RETURNING project_id',
    [projectId]
  );

  return rows.length > 0;
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
