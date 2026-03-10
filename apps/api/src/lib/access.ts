import { queryOne } from '../db/index.js';

export async function checkProjectAccess(userId: string, projectId: string): Promise<boolean> {
  // 检查用户是否属于项目所属的租户
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM druvia_projects p
      JOIN druvia_tenants t ON t.tenant_id = p.tenant_id
      WHERE p.project_id = $1 AND t.owner_uid = (
        SELECT id FROM druvia_users WHERE user_id = $2
      )
    ) as exists`,
    [projectId, userId]
  );
  return result?.exists || false;
}

export async function checkSchemaAccess(userId: string, schemaName: string): Promise<boolean> {
  // 检查用户是否有权访问该 schema
  // 支持项目基础 schema 和环境 schema
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM druvia_projects p
      JOIN druvia_tenants t ON t.tenant_id = p.tenant_id
      WHERE t.owner_uid = (SELECT id FROM druvia_users WHERE user_id = $2)
        AND (
          p.schema_name = $1
          OR EXISTS (
            SELECT 1 FROM druvia_project_environments e
            WHERE e.project_id = p.project_id AND e.schema_name = $1
          )
        )
    ) as exists`,
    [schemaName, userId]
  );
  return result?.exists || false;
}
