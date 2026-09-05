import { queryOne } from '../db/index.js';

export async function checkTenantAccess(userId: string, tenantId: string): Promise<boolean> {
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1
      FROM druvia_tenants t
      JOIN druvia_users u ON u.user_id = $2 AND u.status = 'active'
      WHERE t.tenant_id = $1
        AND (
          u.role = 'super_admin'
          OR t.owner_uid = u.id
          OR EXISTS (
            SELECT 1
            FROM druvia_projects p
            JOIN druvia_project_members pm ON pm.project_id = p.project_id
            WHERE p.tenant_id = t.tenant_id AND pm.user_uid = u.id
          )
        )
    ) AS exists`,
    [tenantId, userId]
  );

  return result?.exists || false;
}

export async function checkProjectAccess(userId: string, projectId: string): Promise<boolean> {
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM druvia_projects p
      JOIN druvia_tenants t ON t.tenant_id = p.tenant_id
      JOIN druvia_users u ON u.user_id = $2 AND u.status = 'active'
      LEFT JOIN druvia_project_members pm
        ON pm.project_id = p.project_id AND pm.user_uid = u.id
      WHERE p.project_id = $1
        AND (u.role = 'super_admin' OR t.owner_uid = u.id OR pm.id IS NOT NULL)
    ) as exists`,
    [projectId, userId]
  );
  return result?.exists || false;
}

export async function checkSchemaAccess(userId: string, schemaName: string): Promise<boolean> {
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM druvia_projects p
      JOIN druvia_tenants t ON t.tenant_id = p.tenant_id
      JOIN druvia_users u ON u.user_id = $2 AND u.status = 'active'
      LEFT JOIN druvia_project_members pm
        ON pm.project_id = p.project_id AND pm.user_uid = u.id
      WHERE (u.role = 'super_admin' OR t.owner_uid = u.id OR pm.id IS NOT NULL)
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
