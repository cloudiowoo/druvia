import { query, queryOne } from '../../db/index.js';
import { generateTenantId } from '@druvia/shared';
import type { Tenant, CreateTenantInput, UpdateTenantInput } from '@druvia/shared';
import { validateAlias } from '../../lib/validation.js';

// Database row type (snake_case)
interface TenantRow {
  id: number;
  tenant_id: string;
  alias: string;
  name: string;
  owner_uid: number;
  plan: string;
  settings: Record<string, unknown>;
  status: string;
  description: string | null;
  storage_limit: number;
  project_limit: number;
  user_limit: number;
  created_at: Date;
  updated_at: Date;
}

// Convert database row to Tenant interface
function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    alias: row.alias,
    name: row.name,
    ownerUid: row.owner_uid,
    plan: row.plan as Tenant['plan'],
    settings: row.settings,
    status: row.status as Tenant['status'],
    description: row.description,
    storageLimit: row.storage_limit,
    projectLimit: row.project_limit,
    userLimit: row.user_limit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createTenant(input: CreateTenantInput): Promise<Tenant> {
  validateAlias(input.alias, '租户别名');
  const tenantId = generateTenantId();
  const row = await queryOne<TenantRow>(
    `INSERT INTO druvia_tenants (tenant_id, alias, name, owner_uid, plan)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [tenantId, input.alias, input.name, input.ownerUid, input.plan || 'free']
  );

  if (!row) {
    throw new Error('Failed to create tenant');
  }

  return toTenant(row);
}

export async function getTenantById(tenantId: string): Promise<Tenant | null> {
  const row = await queryOne<TenantRow>(
    'SELECT * FROM druvia_tenants WHERE tenant_id = $1',
    [tenantId]
  );
  return row ? toTenant(row) : null;
}

export async function getTenantByAlias(alias: string): Promise<Tenant | null> {
  const row = await queryOne<TenantRow>(
    'SELECT * FROM druvia_tenants WHERE alias = $1',
    [alias]
  );
  return row ? toTenant(row) : null;
}

export async function listTenants(ownerUid?: number, limit = 50, offset = 0): Promise<Tenant[]> {
  let rows: TenantRow[];

  if (ownerUid !== undefined) {
    rows = await query<TenantRow>(
      'SELECT * FROM druvia_tenants WHERE owner_uid = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [ownerUid, limit, offset]
    );
  } else {
    rows = await query<TenantRow>(
      'SELECT * FROM druvia_tenants ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
  }

  return rows.map(toTenant);
}

export async function updateTenant(tenantId: string, input: UpdateTenantInput): Promise<Tenant | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(input.name);
  }
  if (input.description !== undefined) {
    updates.push(`description = $${paramIndex++}`);
    values.push(input.description);
  }
  if (input.plan !== undefined) {
    updates.push(`plan = $${paramIndex++}`);
    values.push(input.plan);
  }
  if (input.settings !== undefined) {
    updates.push(`settings = $${paramIndex++}`);
    values.push(input.settings);
  }
  if (input.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(input.status);
  }
  if (input.storageLimit !== undefined) {
    updates.push(`storage_limit = $${paramIndex++}`);
    values.push(input.storageLimit);
  }
  if (input.projectLimit !== undefined) {
    updates.push(`project_limit = $${paramIndex++}`);
    values.push(input.projectLimit);
  }
  if (input.userLimit !== undefined) {
    updates.push(`user_limit = $${paramIndex++}`);
    values.push(input.userLimit);
  }

  if (updates.length === 0) {
    return getTenantById(tenantId);
  }

  values.push(tenantId);
  const row = await queryOne<TenantRow>(
    `UPDATE druvia_tenants SET ${updates.join(', ')} WHERE tenant_id = $${paramIndex} RETURNING *`,
    values
  );

  return row ? toTenant(row) : null;
}

export async function deleteTenant(tenantId: string): Promise<boolean> {
  const rows = await query<{ tenant_id: string }>(
    'DELETE FROM druvia_tenants WHERE tenant_id = $1 RETURNING tenant_id',
    [tenantId]
  );
  return rows.length > 0;
}
