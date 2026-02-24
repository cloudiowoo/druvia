import { query } from '../../db/index.js';
import { generateTenantId } from '@druvia/shared';
import type { Tenant, TenantConfig } from '@druvia/shared';

export interface CreateTenantInput {
  name: string;
  slug: string;
}

export interface UpdateTenantInput {
  name?: string;
  slug?: string;
}

export async function createTenant(input: CreateTenantInput): Promise<Tenant> {
  const id = generateTenantId();
  const rows = await query<Tenant>(
    `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3) RETURNING *`,
    [id, input.name, input.slug]
  );

  // Create default config
  await query(
    `INSERT INTO tenant_configs (tenant_id) VALUES ($1)`,
    [id]
  );

  return rows[0];
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const rows = await query<Tenant>(
    `SELECT * FROM tenants WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const rows = await query<Tenant>(
    `SELECT * FROM tenants WHERE slug = $1`,
    [slug]
  );
  return rows[0] || null;
}

export async function listTenants(limit = 50, offset = 0): Promise<Tenant[]> {
  return query<Tenant>(
    `SELECT * FROM tenants ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
}

export async function updateTenant(id: string, input: UpdateTenantInput): Promise<Tenant | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(input.name);
  }
  if (input.slug !== undefined) {
    updates.push(`slug = $${paramIndex++}`);
    values.push(input.slug);
  }

  if (updates.length === 0) {
    return getTenantById(id);
  }

  values.push(id);
  const rows = await query<Tenant>(
    `UPDATE tenants SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return rows[0] || null;
}

export async function deleteTenant(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM tenants WHERE id = $1 RETURNING id`,
    [id]
  );
  return rows.length > 0;
}

export async function getTenantConfig(tenantId: string): Promise<TenantConfig | null> {
  const rows = await query<{
    tenant_id: string;
    feature_storage: boolean;
    feature_auth: boolean;
    feature_realtime: boolean;
    feature_functions: boolean;
    limit_storage_bytes: number;
    limit_database_rows: number;
    limit_api_requests_per_day: number;
  }>(
    `SELECT * FROM tenant_configs WHERE tenant_id = $1`,
    [tenantId]
  );

  if (!rows[0]) return null;

  const row = rows[0];
  return {
    tenantId: row.tenant_id,
    features: {
      storage: row.feature_storage,
      auth: row.feature_auth,
      realtime: row.feature_realtime,
      functions: row.feature_functions,
    },
    limits: {
      maxStorageBytes: row.limit_storage_bytes,
      maxDatabaseRows: row.limit_database_rows,
      maxApiRequestsPerDay: row.limit_api_requests_per_day,
    },
  };
}
