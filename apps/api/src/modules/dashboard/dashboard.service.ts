// apps/api/src/modules/dashboard/dashboard.service.ts
import { query, queryOne } from '../../db/index.js';
import { redis } from '../../lib/redis.js';
import { checkHasuraConnection } from '../realtime/realtime.service.js';

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

export type TenantDashboardHealthState = 'healthy' | 'risk' | 'unknown';
export type TenantDashboardHealthStatus = 'healthy' | 'attention' | 'risk';
export type TenantDashboardCapabilityKey = 'database' | 'auth' | 'storage' | 'realtime' | 'functions';
export type TenantDashboardProjectCapabilityState = 'ready' | 'configured' | 'missing' | 'attention';

export interface TenantDashboardCapabilityStatus {
  key: TenantDashboardCapabilityKey;
  label: string;
  coveredProjects: number;
  totalProjects: number;
  status: TenantDashboardHealthStatus;
}

export interface TenantDashboardServiceStatus {
  api: TenantDashboardHealthState;
  database: TenantDashboardHealthState;
  redis: TenantDashboardHealthState;
  hasura: TenantDashboardHealthState;
  worker: TenantDashboardHealthState;
}

export interface TenantDashboardActionItem {
  severity: 'high' | 'medium' | 'low';
  scope: 'workspace' | 'project';
  title: string;
  description: string;
  href: string;
}

export interface TenantDashboardOverview {
  workspace: {
    tenantId: string;
    label: string;
  };
  health: {
    score: number;
    status: TenantDashboardHealthStatus;
    summary: string;
    factors: {
      availability: number;
      stability: number;
      risk: number;
    };
  };
  actionItems: TenantDashboardActionItem[];
  metrics: {
    totalProjects: number;
    activeProjects: number;
    capabilityCoverage: number;
    backupCoverage: number;
    storageUsageBytes: number;
    backupUsageBytes: number;
  };
  capabilities: TenantDashboardCapabilityStatus[];
  serviceStatus: TenantDashboardServiceStatus;
  updatedAt: string;
}

export interface TenantDashboardProjectRow {
  projectId: string;
  name: string;
  alias: string;
  status: string;
  healthScore: number;
  healthStatus: TenantDashboardHealthStatus;
  capabilities: {
    database: TenantDashboardProjectCapabilityState;
    auth: TenantDashboardProjectCapabilityState;
    storage: TenantDashboardProjectCapabilityState;
    realtime: TenantDashboardProjectCapabilityState;
    functions: TenantDashboardProjectCapabilityState;
  };
  latestSignalAt: string | null;
  latestBackupAt: string | null;
  riskTags: string[];
}

export interface TenantDashboardTimelineEntry {
  id: string;
  kind: 'activity' | 'incident';
  title: string;
  description: string | null;
  createdAt: string;
  href: string | null;
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

interface TenantProjectHealthSourceRow {
  project_id: string;
  name: string;
  alias: string;
  status: string;
  schema_name: string | null;
  updated_at: Date | string;
  auth_configured: boolean;
  has_files: boolean;
  has_storage_bucket: boolean;
  has_storage_objects: boolean;
  has_active_functions: boolean;
  has_backup_failures_24h: boolean;
  has_function_failures_24h: boolean;
  latest_backup_at: Date | string | null;
  latest_backup_signal_at: Date | string | null;
  latest_function_log_at: Date | string | null;
}

interface BuildTenantHealthInput {
  totalProjects: number;
  activeProjects: number;
  projectHealthAverage?: number;
  backupCoverage: number;
  serviceStatus: TenantDashboardServiceStatus;
  actionItems: TenantDashboardActionItem[];
  capabilities: TenantDashboardCapabilityStatus[];
  signalCoverage?: number;
  hasRecentFailures?: boolean;
  hasDisabledProjects?: boolean;
  storageConfigured?: boolean;
  partialSignals?: boolean;
}

const WORKER_HEALTH_URL = process.env.DENO_WORKER_URL;

export async function getTenantOverview(tenantId: string): Promise<TenantDashboardOverview> {
  const serviceStatus = await collectTenantServiceStatus();
  const projectRows = await getTenantProjectHealth(tenantId, serviceStatus);
  const totalProjects = projectRows.length;
  const activeProjects = projectRows.filter((project) => project.status === 'active').length;

  const backupStats = await queryOne<{
    covered_projects: string;
    backup_usage_bytes: string;
  }>(
    `SELECT
       COUNT(DISTINCT project_id) FILTER (
         WHERE status = 'completed' AND completed_at >= NOW() - INTERVAL '7 days'
       ) AS covered_projects,
       COALESCE(SUM(size_bytes), 0) AS backup_usage_bytes
     FROM druvia_backups
     WHERE tenant_id = $1`,
    [tenantId]
  );

  const fileUsage = await queryOne<{ storage_usage_bytes: string }>(
    `SELECT (
       COALESCE((
         SELECT SUM(so.size)
         FROM druvia_storage_objects so
         JOIN druvia_storage_buckets sb ON sb.bucket_id = so.bucket_id
         JOIN druvia_projects p ON p.project_id = sb.project_id
         WHERE p.tenant_id = $1
       ), 0)
       + COALESCE((
         SELECT SUM(size_bytes)
         FROM druvia_files
         WHERE tenant_id = $1
       ), 0)
     ) AS storage_usage_bytes`,
    [tenantId]
  );

  const storageConfig = await queryOne<{ tenant_id: string }>(
    'SELECT tenant_id FROM druvia_tenant_storage_config WHERE tenant_id = $1',
    [tenantId]
  );
  const storageBucketCount = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM druvia_storage_buckets sb
     JOIN druvia_projects p ON p.project_id = sb.project_id
     WHERE p.tenant_id = $1`,
    [tenantId]
  );
  const legacyFileCount = await queryOne<{ count: string }>(
    'SELECT COUNT(*) AS count FROM druvia_files WHERE tenant_id = $1',
    [tenantId]
  );

  const storageConfigured = resolveTenantStorageConfigured({
    hasTenantStorageConfig: !!storageConfig,
    bucketCount: Number(storageBucketCount?.count || '0'),
    legacyFileCount: Number(legacyFileCount?.count || '0'),
  });

  const backupCoverage = totalProjects === 0
    ? 0
    : Math.round((Number(backupStats?.covered_projects || '0') / totalProjects) * 100);

  const capabilities = buildTenantCapabilities(projectRows, {
    totalProjects,
    storageConfigured,
    serviceStatus,
  });

  const actionItems = buildTenantActionItems({
    tenantId,
    projectRows,
    backupCoverage,
    serviceStatus,
    storageConfigured,
  });

  const health = buildTenantHealth({
    totalProjects,
    activeProjects,
    projectHealthAverage: totalProjects > 0
      ? projectRows.reduce((sum, project) => sum + project.healthScore, 0) / totalProjects
      : undefined,
    backupCoverage,
    serviceStatus,
    actionItems,
    capabilities,
    signalCoverage: computeSignalCoverage(projectRows),
    hasRecentFailures: projectRows.some((project) => hasRecentProjectFailures(project)),
    hasDisabledProjects: projectRows.some((project) => project.status === 'disabled'),
    storageConfigured,
    partialSignals: Object.values(serviceStatus).some((status) => status === 'unknown'),
  });

  return {
    workspace: {
      tenantId,
      label: `${tenantId} workspace`,
    },
    health,
    actionItems,
    metrics: {
      totalProjects,
      activeProjects,
      capabilityCoverage: computeCapabilityCoverage(capabilities),
      backupCoverage,
      storageUsageBytes: Number(fileUsage?.storage_usage_bytes || '0'),
      backupUsageBytes: Number(backupStats?.backup_usage_bytes || '0'),
    },
    capabilities,
    serviceStatus,
    updatedAt: new Date().toISOString(),
  };
}

export async function getTenantProjectHealth(
  tenantId: string,
  providedServiceStatus?: TenantDashboardServiceStatus
): Promise<TenantDashboardProjectRow[]> {
  const serviceStatus = providedServiceStatus ?? await collectTenantServiceStatus();
  const storageConfig = await queryOne<{ tenant_id: string }>(
    'SELECT tenant_id FROM druvia_tenant_storage_config WHERE tenant_id = $1',
    [tenantId]
  );
  const storageBucketCount = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM druvia_storage_buckets sb
     JOIN druvia_projects p ON p.project_id = sb.project_id
     WHERE p.tenant_id = $1`,
    [tenantId]
  );
  const legacyFileCount = await queryOne<{ count: string }>(
    'SELECT COUNT(*) AS count FROM druvia_files WHERE tenant_id = $1',
    [tenantId]
  );

  const rows = await query<TenantProjectHealthSourceRow>(
    `SELECT
       p.project_id,
       p.name,
       p.alias,
       p.status,
       p.schema_name,
       p.updated_at,
       (
         EXISTS(SELECT 1 FROM druvia_project_auth_config ac WHERE ac.project_id = p.project_id)
         OR EXISTS(
           SELECT 1
           FROM druvia_project_auth_providers ap
           WHERE ap.project_id = p.project_id AND ap.enabled = true
         )
       ) AS auth_configured,
       EXISTS(SELECT 1 FROM druvia_files f WHERE f.project_id = p.project_id) AS has_files,
       EXISTS(
         SELECT 1
         FROM druvia_storage_buckets sb
         WHERE sb.project_id = p.project_id
       ) AS has_storage_bucket,
       EXISTS(
         SELECT 1
         FROM druvia_storage_buckets sb
         JOIN druvia_storage_objects so ON so.bucket_id = sb.bucket_id
         WHERE sb.project_id = p.project_id
       ) AS has_storage_objects,
       EXISTS(
         SELECT 1
         FROM druvia_functions fn
         WHERE fn.project_id = p.project_id AND fn.status = 'active'
       ) AS has_active_functions,
       EXISTS(
         SELECT 1
         FROM druvia_backups b
         WHERE b.project_id = p.project_id
           AND b.status = 'failed'
           AND b.created_at >= NOW() - INTERVAL '24 hours'
       ) AS has_backup_failures_24h,
       EXISTS(
         SELECT 1
         FROM druvia_functions fn
         JOIN druvia_function_logs fl ON fl.function_id = fn.id
         WHERE fn.project_id = p.project_id
           AND fl.level = 'error'
           AND fl.created_at >= NOW() - INTERVAL '24 hours'
       ) AS has_function_failures_24h,
       (
         SELECT MAX(b.completed_at)
         FROM druvia_backups b
         WHERE b.project_id = p.project_id
           AND b.status = 'completed'
       ) AS latest_backup_at,
       (
         SELECT MAX(COALESCE(b.completed_at, b.created_at))
         FROM druvia_backups b
         WHERE b.project_id = p.project_id
       ) AS latest_backup_signal_at,
       (
         SELECT MAX(fl.created_at)
         FROM druvia_functions fn
         JOIN druvia_function_logs fl ON fl.function_id = fn.id
         WHERE fn.project_id = p.project_id
       ) AS latest_function_log_at
     FROM druvia_projects p
     WHERE p.tenant_id = $1
     ORDER BY p.created_at DESC`,
    [tenantId]
  );

  const storageConfigured = resolveTenantStorageConfigured({
    hasTenantStorageConfig: !!storageConfig,
    bucketCount: Number(storageBucketCount?.count || '0'),
    legacyFileCount: Number(legacyFileCount?.count || '0'),
  });
  const projectRows = rows.map((row) => mapTenantProjectHealthRow(row, tenantId, serviceStatus, storageConfigured));

  return projectRows.sort((left, right) => left.healthScore - right.healthScore);
}

export async function getTenantTimeline(
  tenantId: string,
  limit = 20
): Promise<TenantDashboardTimelineEntry[]> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 20;

  const backupEvents = await query<{
    backup_id: string;
    project_id: string | null;
    status: string;
    error_message: string | null;
    event_at: Date | string;
  }>(
    `SELECT
       backup_id,
       project_id,
       status,
       error_message,
       COALESCE(completed_at, created_at) AS event_at
     FROM druvia_backups
     WHERE tenant_id = $1
     ORDER BY COALESCE(completed_at, created_at) DESC
     LIMIT $2`,
    [tenantId, safeLimit]
  );

  const functionEvents = await query<{
    id: string;
    project_id: string;
    function_name: string;
    level: string;
    message: string | null;
    created_at: Date | string;
  }>(
    `SELECT
       fl.id,
       fn.project_id,
       fn.name AS function_name,
       fl.level,
       fl.message,
       fl.created_at
     FROM druvia_function_logs fl
     JOIN druvia_functions fn ON fn.id = fl.function_id
     JOIN druvia_projects p ON p.project_id = fn.project_id
     WHERE p.tenant_id = $1
     ORDER BY fl.created_at DESC
     LIMIT $2`,
    [tenantId, safeLimit]
  );

  const disabledProjects = await query<{
    project_id: string;
    name: string;
    updated_at: Date | string;
  }>(
    `SELECT project_id, name, updated_at
     FROM druvia_projects
     WHERE tenant_id = $1 AND status = 'disabled'
     ORDER BY updated_at DESC
     LIMIT $2`,
    [tenantId, safeLimit]
  );

  const timeline = [
    ...backupEvents.map<TenantDashboardTimelineEntry>((event) => ({
      id: `backup:${event.backup_id}`,
      kind: event.status === 'failed' ? 'incident' : 'activity',
      title: event.status === 'failed' ? 'backup.create failed' : 'backup.create completed',
      description: event.error_message,
      createdAt: toIsoString(event.event_at) ?? new Date().toISOString(),
      href: `/t/${tenantId}/backups`,
    })),
    ...functionEvents.map<TenantDashboardTimelineEntry>((event) => ({
      id: `function:${event.id}`,
      kind: event.level === 'error' ? 'incident' : 'activity',
      title: event.level === 'error'
        ? 'function execution error'
        : `function execution ${event.level}`,
      description: event.message,
      createdAt: toIsoString(event.created_at) ?? new Date().toISOString(),
      href: `/t/${tenantId}/p/${event.project_id}/functions`,
    })),
    ...disabledProjects.map<TenantDashboardTimelineEntry>((project) => ({
      id: `project:${project.project_id}:disabled`,
      kind: 'incident',
      title: 'project disabled',
      description: `${project.name} 已被禁用`,
      createdAt: toIsoString(project.updated_at) ?? new Date().toISOString(),
      href: `/t/${tenantId}/p/${project.project_id}`,
    })),
  ];

  return timeline
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, safeLimit);
}

export function computeCapabilityCoverage(capabilities: TenantDashboardCapabilityStatus[]): number {
  const ratios = capabilities
    .filter((capability) => capability.totalProjects > 0)
    .map((capability) => capability.coveredProjects / capability.totalProjects);

  if (ratios.length === 0) {
    return 0;
  }

  const average = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
  return Math.round(average * 100);
}

export function buildTenantHealth(input: BuildTenantHealthInput): TenantDashboardOverview['health'] {
  const partialSignals = input.partialSignals
    ?? Object.values(input.serviceStatus).some((status) => status === 'unknown');

  const availability = normalizeFactorScore(
    [
      { weight: 5, state: input.serviceStatus.api },
      { weight: 10, state: input.serviceStatus.database },
      { weight: 5, state: input.serviceStatus.redis },
      { weight: 10, state: input.serviceStatus.hasura },
      { weight: 10, state: input.activeProjects > 0 ? 'healthy' : 'risk' },
    ],
    40
  );

  const stability = clamp(
    Math.round(
      (input.backupCoverage / 100) * 15
      + (input.hasRecentFailures ? 0 : 10)
      + ((input.signalCoverage ?? 0) / 100) * 10
    ),
    0,
    35
  );

  let risk = 0;
  if (input.storageConfigured) risk += 5;
  if (input.capabilities.find((capability) => capability.key === 'auth')?.coveredProjects) risk += 5;
  const functionsCapability = input.capabilities.find((capability) => capability.key === 'functions');
  if (functionsCapability && functionsCapability.coveredProjects > 0 && input.serviceStatus.worker !== 'risk') {
    risk += 5;
  }
  if (!input.hasDisabledProjects) risk += 5;
  risk += 5;
  risk = clamp(risk, 0, 25);

  const rawScore = clamp(availability + stability + risk, 0, 100);
  const score = input.projectHealthAverage !== undefined
    ? Math.min(rawScore, Math.round(input.projectHealthAverage))
    : rawScore;
  const adjustedFactors = adjustHealthFactorsForScore(
    {
      availability,
      stability,
      risk,
    },
    score
  );
  const status = getHealthStatus(score);

  const reasons: string[] = [];
  if (partialSignals) reasons.push('部分信号缺失');
  if (input.backupCoverage < 100) reasons.push('备份覆盖不足');
  if (functionsCapability?.status !== 'healthy') reasons.push('Functions 可用性不足');
  if (input.hasDisabledProjects) reasons.push('存在已禁用项目');
  if (reasons.length === 0) reasons.push('核心服务与关键能力可用');

  return {
    score,
    status,
    summary: reasons.slice(0, 3).join('，'),
    factors: adjustedFactors,
  };
}

export function resolveTenantStorageConfigured(input: {
  hasTenantStorageConfig: boolean;
  bucketCount: number;
  legacyFileCount: number;
}): boolean {
  return input.hasTenantStorageConfig || input.bucketCount > 0 || input.legacyFileCount > 0;
}

export function buildTenantCapabilities(
  projectRows: TenantDashboardProjectRow[],
  options: {
    totalProjects: number;
    storageConfigured: boolean;
    serviceStatus: TenantDashboardServiceStatus;
  }
): TenantDashboardCapabilityStatus[] {
  const totalProjects = options.totalProjects;
  const countWithState = (
    key: keyof TenantDashboardProjectRow['capabilities'],
    states: TenantDashboardProjectCapabilityState[]
  ) => projectRows.filter((project) => states.includes(project.capabilities[key])).length;

  const databaseCovered = countWithState('database', ['ready']);
  const authCovered = countWithState('auth', ['ready', 'configured']);
  const storageCovered = countWithState('storage', ['ready', 'configured']);
  const realtimeCovered = countWithState('realtime', ['ready']);
  const functionsCovered = countWithState('functions', ['ready', 'attention']);
  const hasFunctionsAttention = projectRows.some((project) => project.capabilities.functions === 'attention');

  return [
    {
      key: 'database',
      label: 'Database',
      coveredProjects: databaseCovered,
      totalProjects,
      status: getCapabilityHealthStatus(databaseCovered, totalProjects),
    },
    {
      key: 'auth',
      label: 'Auth',
      coveredProjects: authCovered,
      totalProjects,
      status: getOptionalCapabilityHealthStatus(authCovered, totalProjects),
    },
    {
      key: 'storage',
      label: 'Storage',
      coveredProjects: storageCovered,
      totalProjects,
      status: options.storageConfigured
        ? getCapabilityHealthStatus(storageCovered, totalProjects)
        : 'attention',
    },
    {
      key: 'realtime',
      label: 'Realtime',
      coveredProjects: realtimeCovered,
      totalProjects,
      status: options.serviceStatus.hasura === 'healthy'
        ? getCapabilityHealthStatus(realtimeCovered, totalProjects)
        : 'attention',
    },
    {
      key: 'functions',
      label: 'Functions',
      coveredProjects: functionsCovered,
      totalProjects,
      status: getFunctionsCapabilityHealthStatus({
        coveredProjects: functionsCovered,
        totalProjects,
        workerHealth: options.serviceStatus.worker,
        hasAttentionProjects: hasFunctionsAttention,
      }),
    },
  ];
}

export function buildTenantActionItems(input: {
  tenantId: string;
  projectRows: TenantDashboardProjectRow[];
  backupCoverage: number;
  serviceStatus: TenantDashboardServiceStatus;
  storageConfigured: boolean;
}): TenantDashboardActionItem[] {
  const items: TenantDashboardActionItem[] = [];

  if (input.projectRows.length > 0 && input.backupCoverage === 0) {
    items.push({
      severity: 'high',
      scope: 'workspace',
      title: '最近 7 天没有成功备份',
      description: '当前工作区缺少可用于恢复的最新备份。',
      href: `/t/${input.tenantId}/backups`,
    });
  } else if (input.projectRows.length > 0 && input.backupCoverage < 100) {
    items.push({
      severity: 'high',
      scope: 'workspace',
      title: '部分项目最近 7 天没有成功备份',
      description: '至少有一个项目缺少最近的恢复点。',
      href: `/t/${input.tenantId}/backups`,
    });
  }

  const disabledProject = input.projectRows.find((project) => project.status === 'disabled');
  if (disabledProject) {
    items.push({
      severity: 'high',
      scope: 'project',
      title: `${disabledProject.name} 已被禁用`,
      description: '该项目当前不会继续提供正常服务。',
      href: `/t/${input.tenantId}/p/${disabledProject.projectId}`,
    });
  }

  const hasFunctionsAdoption = input.projectRows.some((project) => project.capabilities.functions !== 'missing');
  if (input.serviceStatus.worker === 'risk' && hasFunctionsAdoption) {
    items.push({
      severity: 'high',
      scope: 'workspace',
      title: 'Functions Worker 不可用',
      description: 'Edge Functions 运行探针失败，相关能力需要检查。',
      href: `/t/${input.tenantId}/settings`,
    });
  }

  const failureProject = input.projectRows.find((project) => project.riskTags.some((tag) => tag.includes('失败')));
  if (failureProject) {
    items.push({
      severity: 'medium',
      scope: 'project',
      title: `${failureProject.name} 最近 24 小时存在失败事件`,
      description: '该项目存在函数执行或备份失败，需要尽快检查。',
      href: `/t/${input.tenantId}/p/${failureProject.projectId}`,
    });
  }

  return items.slice(0, 6);
}

async function collectTenantServiceStatus(): Promise<TenantDashboardServiceStatus> {
  const database = await getDatabaseHealth();
  const hasura = await checkHasuraConnection();

  let redisHealth: TenantDashboardHealthState = 'unknown';
  try {
    const pong = await redis.ping();
    redisHealth = pong === 'PONG' ? 'healthy' : 'risk';
  } catch {
    redisHealth = 'risk';
  }

  const worker = await getWorkerHealth();

  return {
    api: 'healthy',
    database,
    redis: redisHealth,
    hasura: hasura ? 'healthy' : 'risk',
    worker,
  };
}

async function getDatabaseHealth(): Promise<TenantDashboardHealthState> {
  try {
    const row = await queryOne<{ ok: number }>('SELECT 1 AS ok');
    return row?.ok === 1 ? 'healthy' : 'risk';
  } catch {
    return 'risk';
  }
}

async function getWorkerHealth(): Promise<TenantDashboardHealthState> {
  if (!WORKER_HEALTH_URL) {
    return 'unknown';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(`${WORKER_HEALTH_URL}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok ? 'healthy' : 'risk';
  } catch {
    return 'risk';
  } finally {
    clearTimeout(timeout);
  }
}

function mapTenantProjectHealthRow(
  row: TenantProjectHealthSourceRow,
  tenantId: string,
  serviceStatus: TenantDashboardServiceStatus,
  storageConfigured: boolean
): TenantDashboardProjectRow {
  const capabilities = {
    database: row.schema_name ? 'ready' : 'missing',
    auth: row.auth_configured ? 'configured' : 'missing',
    storage: getStorageProjectState(row, storageConfigured),
    realtime: !row.schema_name ? 'missing' : (serviceStatus.hasura === 'healthy' ? 'ready' : 'attention'),
    functions: getFunctionsProjectState(row, serviceStatus.worker),
  } satisfies TenantDashboardProjectRow['capabilities'];

  const latestSignalAt = getLatestDate([
    row.updated_at,
    row.latest_backup_signal_at,
    row.latest_function_log_at,
  ]);

  const riskTags = computeProjectRiskTags({
    projectStatus: row.status,
    capabilities,
    latestBackupAt: toIsoString(row.latest_backup_at),
    hasBackupFailures24h: row.has_backup_failures_24h,
    hasFunctionFailures24h: row.has_function_failures_24h,
  });

  const healthScore = computeProjectHealthScore({
    projectStatus: row.status,
    capabilities,
    latestBackupAt: toIsoString(row.latest_backup_at),
    latestSignalAt,
    hasBackupFailures24h: row.has_backup_failures_24h,
    hasFunctionFailures24h: row.has_function_failures_24h,
  });

  return {
    projectId: row.project_id,
    name: row.name,
    alias: row.alias,
    status: row.status,
    healthScore,
    healthStatus: getHealthStatus(healthScore),
    capabilities,
    latestSignalAt,
    latestBackupAt: toIsoString(row.latest_backup_at),
    riskTags,
  };
}

function getFunctionsProjectState(
  row: TenantProjectHealthSourceRow,
  workerHealth: TenantDashboardHealthState
): TenantDashboardProjectCapabilityState {
  if (!row.has_active_functions) {
    return 'missing';
  }
  if (row.has_function_failures_24h) {
    return 'attention';
  }
  if (workerHealth === 'healthy') {
    return 'ready';
  }
  return 'attention';
}

function getStorageProjectState(
  row: TenantProjectHealthSourceRow,
  storageConfigured: boolean
): TenantDashboardProjectCapabilityState {
  if (!storageConfigured) {
    return 'missing';
  }

  if (row.has_storage_objects || row.has_files) {
    return 'ready';
  }

  if (row.has_storage_bucket) {
    return 'configured';
  }

  return 'missing';
}

function hasRecentProjectFailures(project: TenantDashboardProjectRow): boolean {
  return project.riskTags.some((tag) => tag.includes('失败'));
}

function computeSignalCoverage(projectRows: TenantDashboardProjectRow[]): number {
  if (projectRows.length === 0) {
    return 0;
  }

  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const recentSignals = projectRows.filter((project) => {
    if (!project.latestSignalAt) {
      return false;
    }
    return new Date(project.latestSignalAt).getTime() >= sevenDaysAgo;
  }).length;

  return Math.round((recentSignals / projectRows.length) * 100);
}

function normalizeFactorScore(
  items: Array<{ weight: number; state: TenantDashboardHealthState | 'healthy' | 'risk' }>,
  factorMax: number
): number {
  const knownWeight = items
    .filter((item) => item.state !== 'unknown')
    .reduce((sum, item) => sum + item.weight, 0);
  const awarded = items
    .filter((item) => item.state === 'healthy')
    .reduce((sum, item) => sum + item.weight, 0);

  if (knownWeight === 0) {
    return 0;
  }

  return clamp(Math.round((awarded / knownWeight) * factorMax), 0, factorMax);
}

function getCapabilityHealthStatus(coveredProjects: number, totalProjects: number): TenantDashboardHealthStatus {
  if (totalProjects === 0) {
    return 'attention';
  }
  if (coveredProjects === totalProjects) {
    return 'healthy';
  }
  if (coveredProjects > 0) {
    return 'attention';
  }
  return 'risk';
}

function getOptionalCapabilityHealthStatus(coveredProjects: number, totalProjects: number): TenantDashboardHealthStatus {
  if (totalProjects === 0) {
    return 'attention';
  }
  if (coveredProjects === totalProjects) {
    return 'healthy';
  }
  return 'attention';
}

function getFunctionsCapabilityHealthStatus(input: {
  coveredProjects: number;
  totalProjects: number;
  workerHealth: TenantDashboardHealthState;
  hasAttentionProjects: boolean;
}): TenantDashboardHealthStatus {
  if (input.totalProjects === 0) {
    return 'attention';
  }

  if (input.coveredProjects === 0) {
    return 'attention';
  }

  if (input.workerHealth !== 'healthy' || input.hasAttentionProjects || input.coveredProjects < input.totalProjects) {
    return 'attention';
  }

  return 'healthy';
}

export function computeProjectRiskTags(input: {
  projectStatus: string;
  capabilities: {
    database: TenantDashboardProjectCapabilityState;
    auth: TenantDashboardProjectCapabilityState;
    storage: TenantDashboardProjectCapabilityState;
    realtime: TenantDashboardProjectCapabilityState;
    functions: TenantDashboardProjectCapabilityState;
  };
  latestBackupAt: string | null;
  hasBackupFailures24h: boolean;
  hasFunctionFailures24h: boolean;
}): string[] {
  const riskTags: string[] = [];

  if (!input.latestBackupAt) riskTags.push('缺少备份');
  if (input.projectStatus === 'disabled') riskTags.push('项目已禁用');
  if (input.capabilities.database === 'missing') riskTags.push('Database 未创建');
  if (input.hasBackupFailures24h) riskTags.push('最近备份失败');
  if (input.hasFunctionFailures24h) riskTags.push('最近函数失败');
  if (input.capabilities.functions === 'attention' && input.hasFunctionFailures24h) {
    riskTags.push('Functions 需关注');
  }

  return riskTags;
}

export function computeProjectHealthScore(input: {
  projectStatus: string;
  capabilities: {
    database: TenantDashboardProjectCapabilityState;
    auth: TenantDashboardProjectCapabilityState;
    storage: TenantDashboardProjectCapabilityState;
    realtime: TenantDashboardProjectCapabilityState;
    functions: TenantDashboardProjectCapabilityState;
  };
  latestBackupAt: string | null;
  latestSignalAt: string | null;
  hasBackupFailures24h: boolean;
  hasFunctionFailures24h: boolean;
}): number {
  return clamp(
    100
      - (input.projectStatus === 'disabled' ? 30 : 0)
      - (input.capabilities.database === 'missing' ? 25 : 0)
      - (input.capabilities.realtime === 'attention' ? 5 : 0)
      - (input.capabilities.functions === 'attention' ? 8 : 0)
      - (!input.latestBackupAt ? 15 : 0)
      - (input.hasBackupFailures24h ? 8 : 0)
      - (input.hasFunctionFailures24h ? 10 : 0)
      - (!input.latestSignalAt ? 5 : 0),
    0,
    100
  );
}

function getHealthStatus(score: number): TenantDashboardHealthStatus {
  if (score >= 85) return 'healthy';
  if (score >= 60) return 'attention';
  return 'risk';
}

function getLatestDate(values: Array<Date | string | null | undefined>): string | null {
  const timestamps = values
    .map((value) => {
      if (!value) return null;
      const time = new Date(value).getTime();
      return Number.isNaN(time) ? null : time;
    })
    .filter((value): value is number => value !== null);

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function adjustHealthFactorsForScore(
  factors: { availability: number; stability: number; risk: number },
  score: number
) {
  const total = factors.availability + factors.stability + factors.risk;
  let delta = total - score;

  if (delta <= 0) {
    return factors;
  }

  const adjusted = { ...factors };
  const keys: Array<keyof typeof adjusted> = ['risk', 'stability', 'availability'];

  for (const key of keys) {
    if (delta <= 0) break;
    const reducible = Math.min(adjusted[key], delta);
    adjusted[key] -= reducible;
    delta -= reducible;
  }

  return adjusted;
}
