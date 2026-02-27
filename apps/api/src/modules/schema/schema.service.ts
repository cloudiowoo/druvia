import { pool, query, queryOne, execute } from '../../db/index.js';
import { generateSchemaName } from '../../lib/validation.js';

// Schema 命名规范: tenant_{alias} 或 t_{tenant}_{project}
export function getTenantSchemaName(tenantAlias: string): string {
  return `tenant_${tenantAlias.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
}

export function getProjectSchemaName(tenantAlias: string, projectAlias: string): string {
  return generateSchemaName(tenantAlias, projectAlias);
}

// 创建租户 Schema
export async function createTenantSchema(tenantId: string, tenantAlias: string): Promise<string> {
  const schemaName = getTenantSchemaName(tenantAlias);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 创建 Schema
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    // 创建元数据表
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schemaName}"._meta_tables (
        id SERIAL PRIMARY KEY,
        table_name VARCHAR(128) NOT NULL UNIQUE,
        description TEXT,
        row_count BIGINT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schemaName}"._meta_functions (
        id SERIAL PRIMARY KEY,
        function_name VARCHAR(128) NOT NULL UNIQUE,
        description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schemaName}"._meta_views (
        id SERIAL PRIMARY KEY,
        view_name VARCHAR(128) NOT NULL UNIQUE,
        description TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // 注册到 Schema Registry
    await client.query(
      `INSERT INTO druvia_schema_registry (schema_name, tenant_id, schema_type)
       VALUES ($1, $2, 'tenant')
       ON CONFLICT (schema_name) DO NOTHING`,
      [schemaName, tenantId]
    );

    await client.query('COMMIT');
    return schemaName;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 创建项目 Schema
export async function createProjectSchema(
  tenantId: string,
  tenantAlias: string,
  projectId: string,
  projectAlias: string
): Promise<string> {
  const schemaName = getProjectSchemaName(tenantAlias, projectAlias);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 创建 Schema
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    // 创建元数据表
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${schemaName}"._meta_tables (
        id SERIAL PRIMARY KEY,
        table_name VARCHAR(128) NOT NULL UNIQUE,
        description TEXT,
        row_count BIGINT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // 注册到 Schema Registry
    await client.query(
      `INSERT INTO druvia_schema_registry (schema_name, tenant_id, project_id, schema_type)
       VALUES ($1, $2, $3, 'project')
       ON CONFLICT (schema_name) DO NOTHING`,
      [schemaName, tenantId, projectId]
    );

    // 更新项目的 schema_name
    await client.query(
      `UPDATE druvia_projects SET schema_name = $1 WHERE project_id = $2`,
      [schemaName, projectId]
    );

    await client.query('COMMIT');
    return schemaName;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 删除 Schema
export async function dropSchema(schemaName: string): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 删除 Schema（CASCADE 会删除所有对象）
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);

    // 从 Registry 中删除
    await client.query(
      'DELETE FROM druvia_schema_registry WHERE schema_name = $1',
      [schemaName]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 获取 Schema 统计信息
export async function getSchemaStats(schemaName: string): Promise<{
  tableCount: number;
  functionCount: number;
  viewCount: number;
  sizeBytes: number;
} | null> {
  // 获取表数量
  const tableResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    [schemaName]
  );

  if (!tableResult) return null;

  // 获取函数数量
  const funcResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM information_schema.routines
     WHERE routine_schema = $1`,
    [schemaName]
  );

  // 获取视图数量
  const viewResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM information_schema.views
     WHERE table_schema = $1`,
    [schemaName]
  );

  // 获取 Schema 大小
  const sizeResult = await queryOne<{ size: string }>(
    `SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) as size
     FROM pg_tables WHERE schemaname = $1`,
    [schemaName]
  );

  return {
    tableCount: parseInt(tableResult.count, 10),
    functionCount: parseInt(funcResult?.count || '0', 10),
    viewCount: parseInt(viewResult?.count || '0', 10),
    sizeBytes: parseInt(sizeResult?.size || '0', 10),
  };
}

// 更新 Schema Registry 统计
export async function updateSchemaRegistryStats(schemaName: string): Promise<void> {
  const stats = await getSchemaStats(schemaName);
  if (!stats) return;

  await execute(
    `UPDATE druvia_schema_registry
     SET table_count = $1, function_count = $2, view_count = $3, size_bytes = $4
     WHERE schema_name = $5`,
    [stats.tableCount, stats.functionCount, stats.viewCount, stats.sizeBytes, schemaName]
  );
}

// 列出租户的所有 Schema
export async function listTenantSchemas(tenantId: string): Promise<Array<{
  schemaName: string;
  schemaType: string;
  projectId: string | null;
  tableCount: number;
  sizeBytes: number;
}>> {
  const rows = await query<{
    schema_name: string;
    schema_type: string;
    project_id: string | null;
    table_count: number;
    size_bytes: number;
  }>(
    `SELECT schema_name, schema_type, project_id, table_count, size_bytes
     FROM druvia_schema_registry WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId]
  );

  return rows.map(row => ({
    schemaName: row.schema_name,
    schemaType: row.schema_type,
    projectId: row.project_id,
    tableCount: row.table_count,
    sizeBytes: row.size_bytes,
  }));
}
