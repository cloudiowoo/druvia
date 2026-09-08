import { query } from '../../db/index.js';
import { config } from '../../config/index.js';
import type { ProjectDataAccessMode } from '@druvia/shared';
import { resolveDataScopeRole } from '../data-access/data-scope-role.js';
import { derivePublicRealtimeUrl } from './realtime-token.service.js';

// ============================================
// Types
// ============================================

export interface TableSubscription {
  tableName: string;
  schemaName: string;
  enabled: boolean;
  operations: ('INSERT' | 'UPDATE' | 'DELETE')[];
  hasAuthenticatedRead: boolean;
  hasAnonymousRead: boolean;
  hasSelectPermission: boolean;
  permissionStatus: 'known' | 'unknown';
  accessStatus: RealtimeAccessStatus;
}

export type RealtimeAccessStatus = 'disabled' | 'access_required' | 'ready' | 'unknown';

export interface RealtimeConfig {
  schemaName: string;
  websocketEndpoint: string;
  graphqlEndpoint: string;
}

export interface SubscriptionStats {
  totalTables: number;
  enabledTables: number;
  disabledTables: number;
}

export interface RealtimeRuntimeScope {
  projectId: string;
  runtimeMode: ProjectDataAccessMode;
  environmentId?: number;
}

interface HasuraTableMetadata {
  table: { schema: string; name: string };
  select_permissions?: Array<{ role: string }>;
}

interface HasuraMetadata {
  sources?: Array<{ tables?: HasuraTableMetadata[] }>;
}

// ============================================
// Hasura Metadata API
// ============================================

const HASURA_METADATA_URL = `${config.hasura.endpoint}/v1/metadata`;

export class HasuraMetadataRequestError extends Error {
  readonly code: string | null

  constructor(
    readonly status: number,
    readonly responseBody: string
  ) {
    super(`Hasura metadata request failed with HTTP ${status}: ${responseBody}`)
    this.name = 'HasuraMetadataRequestError'
    this.code = parseHasuraErrorCode(responseBody)
  }

  get isDefinitiveRejection(): boolean {
    return this.status >= 400
      && this.status < 500
      && ![408, 425, 429].includes(this.status)
      && this.code !== null
  }
}

export async function hasuraMetadataRequest<T = unknown>(
  type: string,
  args: Record<string, unknown>
): Promise<T> {
  const response = await fetch(HASURA_METADATA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hasura-Admin-Secret': config.hasura.adminSecret,
    },
    body: JSON.stringify({ type, args }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new HasuraMetadataRequestError(response.status, errorText);
  }

  return response.json() as Promise<T>;
}

export interface HasuraMetadataRequestOptions {
  version?: number
  resourceVersion?: bigint
  timeoutMs?: number
}

export async function hasuraMetadataRequestWithOptions<T = unknown>(
  type: string,
  args: Record<string, unknown> | unknown[],
  options: HasuraMetadataRequestOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const response = await fetch(HASURA_METADATA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hasura-Admin-Secret': config.hasura.adminSecret,
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      type,
      args,
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.resourceVersion === undefined
        ? {}
        : { resource_version: Number(options.resourceVersion) }),
    }),
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new HasuraMetadataRequestError(response.status, errorText)
  }
  return response.json() as Promise<T>
}

function parseHasuraErrorCode(responseBody: string): string | null {
  try {
    const parsed = JSON.parse(responseBody) as { code?: unknown }
    return typeof parsed.code === 'string' && parsed.code.length > 0 ? parsed.code : null
  } catch {
    return null
  }
}

// ============================================
// Table Subscriptions
// ============================================

/**
 * 获取 schema 下所有表的订阅配置
 * 从 _meta_tables 读取 realtime_enabled 标记
 */
export async function getTableSubscriptions(
  schemaName: string,
  runtimeScope: RealtimeRuntimeScope
): Promise<TableSubscription[]> {
  validateSchemaName(schemaName);
  await ensureRealtimeMetaTable(schemaName);

  // LEFT JOIN information_schema.tables with _meta_tables to get realtime_enabled
  // Tables not in _meta_tables default to realtime_enabled=false
  const rows = await query<{ table_name: string; realtime_enabled: boolean }>(
    `SELECT t.table_name, COALESCE(m.realtime_enabled, false) as realtime_enabled
     FROM information_schema.tables t
     LEFT JOIN "${schemaName}"._meta_tables m ON m.table_name = t.table_name
     WHERE t.table_schema = $1
       AND t.table_type = 'BASE TABLE'
       AND t.table_name NOT LIKE '\\_%'
     ORDER BY t.table_name`,
    [schemaName]
  );
  const selectRoles = await tryGetSchemaSelectRoles(schemaName);

  return rows.map((row) => {
    const readAccess = classifyRuntimeReadAccess(
      selectRoles?.get(row.table_name),
      runtimeScope
    );
    const permissionStatus = selectRoles ? 'known' : 'unknown';

    return {
      tableName: row.table_name,
      schemaName,
      enabled: row.realtime_enabled,
      operations: ['INSERT', 'UPDATE', 'DELETE'] as const,
      ...readAccess,
      permissionStatus,
      accessStatus: deriveRealtimeAccessStatus(
        row.realtime_enabled,
        permissionStatus,
        readAccess.hasSelectPermission
      ),
    };
  });
}

/**
 * 获取订阅统计信息
 */
export async function getSubscriptionStats(
  schemaName: string,
  runtimeScope: RealtimeRuntimeScope
): Promise<SubscriptionStats> {
  const subscriptions = await getTableSubscriptions(schemaName, runtimeScope);

  return summarizeSubscriptions(subscriptions);
}

export function summarizeSubscriptions(
  subscriptions: TableSubscription[]
): SubscriptionStats {
  return {
    totalTables: subscriptions.length,
    enabledTables: subscriptions.filter((s) => s.enabled).length,
    disabledTables: subscriptions.filter((s) => !s.enabled).length,
  };
}

/**
 * 配置表订阅能力。读取权限由独立的数据访问配置管理。
 */
export async function configureTableSubscription(
  schemaName: string,
  tableName: string,
  enabled: boolean,
  runtimeScope: RealtimeRuntimeScope,
): Promise<TableSubscription> {
  validateSchemaName(schemaName);
  validateTableName(tableName);
  await ensureRealtimeMetaTable(schemaName);

  if (enabled) {
    try {
      await hasuraMetadataRequest('pg_track_table', {
        source: 'default',
        table: { schema: schemaName, name: tableName },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes('already tracked') && !errorMsg.includes('already exists')) {
        throw error;
      }
    }
  }

  // Persist the capability only after required Hasura tracking succeeds.
  await query(
    `INSERT INTO "${schemaName}"._meta_tables (table_name, realtime_enabled, updated_at)
     VALUES ($2, $1, NOW())
     ON CONFLICT (table_name) DO UPDATE SET realtime_enabled = $1, updated_at = NOW()`,
    [enabled, tableName]
  );

  const selectRoles = await tryGetSchemaSelectRoles(schemaName);
  const readAccess = classifyRuntimeReadAccess(selectRoles?.get(tableName), runtimeScope);
  const permissionStatus = selectRoles ? 'known' : 'unknown';

  return {
    tableName,
    schemaName,
    enabled,
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    ...readAccess,
    permissionStatus,
    accessStatus: deriveRealtimeAccessStatus(
      enabled,
      permissionStatus,
      readAccess.hasSelectPermission
    ),
  };
}

function resolveRuntimeReadRoles(runtimeScope: RealtimeRuntimeScope): {
  authenticatedRole: string;
  anonymousRole: string;
} {
  if (runtimeScope.runtimeMode !== 'explicit') {
    return { authenticatedRole: 'user', anonymousRole: 'anonymous' };
  }

  return {
    authenticatedRole: resolveDataScopeRole({
      projectId: runtimeScope.projectId,
      environmentId: runtimeScope.environmentId,
      actor: 'authenticated',
    }),
    anonymousRole: resolveDataScopeRole({
      projectId: runtimeScope.projectId,
      environmentId: runtimeScope.environmentId,
      actor: 'anonymous',
    }),
  };
}

function classifyRuntimeReadAccess(
  selectRoles: string[] | undefined,
  runtimeScope: RealtimeRuntimeScope
): {
  hasAuthenticatedRead: boolean;
  hasAnonymousRead: boolean;
  hasSelectPermission: boolean;
} {
  const { authenticatedRole, anonymousRole } = resolveRuntimeReadRoles(runtimeScope);
  const hasAuthenticatedRead = selectRoles?.includes(authenticatedRole) ?? false;
  const hasAnonymousRead = selectRoles?.includes(anonymousRole) ?? false;

  return {
    hasAuthenticatedRead,
    hasAnonymousRead,
    hasSelectPermission: hasAuthenticatedRead || hasAnonymousRead,
  };
}

export function deriveRealtimeAccessStatus(
  enabled: boolean,
  permissionStatus: 'known' | 'unknown',
  hasSelectPermission: boolean
): RealtimeAccessStatus {
  if (!enabled) return 'disabled';
  if (permissionStatus === 'unknown') return 'unknown';
  return hasSelectPermission ? 'ready' : 'access_required';
}

async function tryGetSchemaSelectRoles(schemaName: string): Promise<Map<string, string[]> | null> {
  try {
    return await getSchemaSelectRoles(schemaName);
  } catch {
    return null;
  }
}

export async function getSchemaSelectRoles(schemaName: string): Promise<Map<string, string[]>> {
  validateSchemaName(schemaName);
  const metadata = await hasuraMetadataRequest<HasuraMetadata>('export_metadata', {});
  const result = new Map<string, string[]>();

  for (const source of metadata.sources ?? []) {
    for (const table of source.tables ?? []) {
      if (table.table.schema !== schemaName) continue;
      result.set(
        table.table.name,
        table.select_permissions?.map((permission) => permission.role) ?? []
      );
    }
  }

  return result;
}

// ============================================
// Realtime Configuration
// ============================================

/**
 * 获取实时配置信息
 */
export function getRealtimeConfig(schemaName: string): RealtimeConfig {
  const websocketEndpoint = derivePublicRealtimeUrl({
    hasuraPublicUrl: config.realtime.hasuraPublicUrl,
    apiBaseUrl: config.realtime.apiBaseUrl,
    nodeEnv: config.nodeEnv,
    hasuraEndpoint: config.hasura.endpoint,
  });
  const graphqlEndpoint = websocketEndpoint
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:');

  return {
    schemaName,
    websocketEndpoint,
    graphqlEndpoint,
  };
}

// ============================================
// Subscription Code Generator
// ============================================

export interface SubscriptionExample {
  language: 'javascript' | 'graphql';
  code: string;
  description: string;
}

/**
 * 生成订阅代码示例
 */
export function generateSubscriptionExample(
  schemaName: string,
  tableName: string,
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL' = 'ALL'
): SubscriptionExample[] {
  // 验证输入参数
  validateSchemaName(schemaName);
  validateTableName(tableName);

  const subscriptionName = `${tableName}_subscription`;
  const fullTableName = `${schemaName}_${tableName}`;

  // GraphQL 订阅示例
  const graphqlCode = `subscription ${subscriptionName} {
  ${fullTableName}(order_by: {created_at: desc}, limit: 10) {
    id
    created_at
    updated_at
    # ... 其他字段
  }
}`;

  const realtimeEvent = operation === 'ALL' ? '*' : operation;

  const jsCode = `import { createClient } from '@druvia/sdk';

const druvia = createClient('YOUR_DRUVIA_URL/api/v1', 'YOUR_PROJECT_API_KEY', {
  projectId: 'YOUR_PROJECT_ID',
  schema: '${schemaName}',
});

const subscription = druvia
  .channel('${tableName}_changes')
  .on(
    'postgres_changes',
    {
      event: '${realtimeEvent}',
      table: '${fullTableName}',
      fields: 'id',
    },
    (event) => console.log('收到变更:', event)
  )
  .subscribe();

// 取消订阅
// subscription.unsubscribe();`;

  return [
    {
      language: 'graphql',
      code: graphqlCode,
      description: 'GraphQL 订阅查询',
    },
    {
      language: 'javascript',
      code: jsCode,
      description: 'JavaScript 客户端示例 (@druvia/sdk)',
    },
  ];
}

// ============================================
// Database Tables in Schema
// ============================================

interface TableInfo {
  tableName: string;
  schemaName: string;
}

async function ensureRealtimeMetaTable(schemaName: string): Promise<void> {
  await query(
    `CREATE TABLE IF NOT EXISTS "${schemaName}"._meta_tables (
       id SERIAL PRIMARY KEY,
       table_name VARCHAR(128) NOT NULL UNIQUE,
       description TEXT,
       row_count BIGINT DEFAULT 0,
       realtime_enabled BOOLEAN NOT NULL DEFAULT false,
       created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
       updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
     )`
  );

  await query(
    `ALTER TABLE "${schemaName}"._meta_tables
     ADD COLUMN IF NOT EXISTS realtime_enabled BOOLEAN NOT NULL DEFAULT false`
  );
}

/**
 * 从数据库获取 schema 下的所有表（排除元数据表）
 */
export async function getTablesInSchema(schemaName: string): Promise<TableInfo[]> {
  validateSchemaName(schemaName);

  const rows = await query<{ table_name: string; table_schema: string }>(
    `SELECT table_name, table_schema
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '\\_%'
     ORDER BY table_name`,
    [schemaName]
  );

  return rows.map((row) => ({
    tableName: row.table_name,
    schemaName: row.table_schema,
  }));
}

// ============================================
// Helper Functions
// ============================================

/**
 * 验证 schema 名称格式，防止 SQL 注入
 */
function validateSchemaName(schemaName: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schemaName)) {
    throw new Error('Invalid schema name format');
  }
}

/**
 * 验证表名格式，防止注入攻击
 */
function validateTableName(tableName: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new Error('Invalid table name format');
  }
}

/**
 * 检查 Hasura 连接是否正常
 */
export async function checkHasuraConnection(): Promise<boolean> {
  try {
    const response = await fetch(`${config.hasura.endpoint}/healthz`, {
      method: 'GET',
    });
    return response.ok;
  } catch {
    return false;
  }
}
