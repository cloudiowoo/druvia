// apps/api/src/modules/dashboard/dashboard.service.ts
import { query, queryOne } from '../../db/index.js';

export interface DashboardStats {
  tenants: { total: number; weekNew: number };
  users: { total: number; weekNew: number };
  backups: { total: number; weekNew: number };
  storage: { used: number; total: number };
}

export interface TrendData {
  date: string;
  tenants: number;
  users: number;
  backups: number;
}

export interface ResourceUsage {
  topTenants: { name: string; size: number }[];
  storageByTenant: { name: string; size: number }[];
}

export async function getStats(): Promise<DashboardStats> {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [tenantTotal, tenantWeek] = await Promise.all([
    queryOne<{ count: string }>('SELECT COUNT(*) as count FROM druvia_tenants'),
    queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM druvia_tenants WHERE created_at >= $1',
      [weekAgo]
    ),
  ]);

  const [userTotal, userWeek] = await Promise.all([
    queryOne<{ count: string }>('SELECT COUNT(*) as count FROM druvia_users'),
    queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM druvia_users WHERE created_at >= $1',
      [weekAgo]
    ),
  ]);

  const [backupTotal, backupWeek] = await Promise.all([
    queryOne<{ count: string }>('SELECT COUNT(*) as count FROM druvia_backups'),
    queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM druvia_backups WHERE created_at >= $1',
      [weekAgo]
    ),
  ]);

  const storageUsed = await queryOne<{ total: string }>(
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM druvia_backups'
  );

  const storageLimit = await queryOne<{ total: string }>(
    'SELECT COALESCE(SUM(storage_limit), 0) as total FROM druvia_tenants'
  );

  return {
    tenants: {
      total: parseInt(tenantTotal?.count || '0', 10),
      weekNew: parseInt(tenantWeek?.count || '0', 10),
    },
    users: {
      total: parseInt(userTotal?.count || '0', 10),
      weekNew: parseInt(userWeek?.count || '0', 10),
    },
    backups: {
      total: parseInt(backupTotal?.count || '0', 10),
      weekNew: parseInt(backupWeek?.count || '0', 10),
    },
    storage: {
      used: parseInt(storageUsed?.total || '0', 10),
      total: parseInt(storageLimit?.total || '0', 10),
    },
  };
}

export async function getTrends(days = 7): Promise<TrendData[]> {
  const results: TrendData[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    const dateStr = date.toISOString().split('T')[0];
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);

    const [tenants, users, backups] = await Promise.all([
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM druvia_tenants
         WHERE created_at >= $1 AND created_at < $2`,
        [date, nextDate]
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM druvia_users
         WHERE created_at >= $1 AND created_at < $2`,
        [date, nextDate]
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM druvia_backups
         WHERE created_at >= $1 AND created_at < $2`,
        [date, nextDate]
      ),
    ]);

    results.push({
      date: dateStr,
      tenants: parseInt(tenants?.count || '0', 10),
      users: parseInt(users?.count || '0', 10),
      backups: parseInt(backups?.count || '0', 10),
    });
  }

  return results;
}

export async function getResourceUsage(): Promise<ResourceUsage> {
  const topTenants = await query<{ name: string; size: string }>(
    `SELECT t.name, COALESCE(SUM(sr.size_bytes), 0) as size
     FROM druvia_tenants t
     LEFT JOIN druvia_schema_registry sr ON t.tenant_id = sr.tenant_id
     GROUP BY t.tenant_id, t.name
     ORDER BY size DESC
     LIMIT 5`
  );

  const storageByTenant = await query<{ name: string; size: string }>(
    `SELECT t.name, COALESCE(SUM(b.size_bytes), 0) as size
     FROM druvia_tenants t
     LEFT JOIN druvia_backups b ON t.tenant_id = b.tenant_id
     GROUP BY t.tenant_id, t.name
     ORDER BY size DESC
     LIMIT 10`
  );

  return {
    topTenants: topTenants.map((r) => ({ name: r.name, size: parseInt(r.size, 10) })),
    storageByTenant: storageByTenant.map((r) => ({ name: r.name, size: parseInt(r.size, 10) })),
  };
}
