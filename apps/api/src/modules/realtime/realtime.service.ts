import { query } from '../../db/index.js';
import { config } from '../../config/index.js';

// ============================================
// Types
// ============================================

export interface TableSubscription {
  tableName: string;
  schemaName: string;
  enabled: boolean;
  operations: ('INSERT' | 'UPDATE' | 'DELETE')[];
  hasSelectPermission: boolean;
}

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

// ============================================
// Hasura Metadata API
// ============================================

const HASURA_METADATA_URL = `${config.hasura.endpoint}/v1/metadata`;
const HASURA_GRAPHQL_URL = `${config.hasura.endpoint}/v1/graphql`;

interface HasuraMetadataResponse {
  metadata?: {
    sources?: Array<{
      name: string;
      tables?: Array<{
        table: { schema: string; name: string };
        select_permissions?: Array<{
          role: string;
          permission: Record<string, unknown>;
        }>;
      }>;
    }>;
  };
}

interface HasuraTable {
  table: { schema: string; name: string };
  select_permissions?: Array<{
    role: string;
    permission: Record<string, unknown>;
  }>;
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
    throw new Error(`Hasura metadata request failed: ${errorText}`);
  }

  return response.json() as Promise<T>;
}

// ============================================
// Table Subscriptions
// ============================================

/**
 * 获取 schema 下所有表的订阅配置
 * 从数据库获取表列表，然后检查 Hasura 中的 track 和权限状态
 */
export async function getTableSubscriptions(schemaName: string): Promise<TableSubscription[]> {
  // 验证 schema 名称格式
  validateSchemaName(schemaName);

  // 1. 从数据库获取 schema 下的所有表（排除元数据表）
  const dbTables = await query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '\\_%'
     ORDER BY table_name`,
    [schemaName]
  );

  if (dbTables.length === 0) {
    return [];
  }

  // 2. 获取 Hasura 元数据，检查哪些表已 track 并有权限
  const trackedTablesMap = new Map<string, HasuraTable>();
  try {
    const metadata = await hasuraMetadataRequest<HasuraMetadataResponse>('export_metadata', {
      version: 2,
    });

    const source = metadata.metadata?.sources?.find((s) => s.name === 'default');
    if (source?.tables) {
      for (const t of source.tables) {
        if (t.table.schema === schemaName) {
          trackedTablesMap.set(t.table.name, t);
        }
      }
    }
  } catch (error) {
    // Hasura 不可用时，所有表显示为未启用
    console.warn('Failed to fetch Hasura metadata:', error);
  }

  // 3. 合并数据库表和 Hasura 状态
  return dbTables.map((row) => {
    const tableName = row.table_name;
    const hasuraTable = trackedTablesMap.get(tableName);
    const hasSelectPermission = !!(
      hasuraTable?.select_permissions &&
      hasuraTable.select_permissions.length > 0
    );

    return {
      tableName,
      schemaName,
      enabled: hasSelectPermission,
      operations: ['INSERT', 'UPDATE', 'DELETE'] as const,
      hasSelectPermission,
    };
  });
}

/**
 * 获取订阅统计信息
 */
export async function getSubscriptionStats(schemaName: string): Promise<SubscriptionStats> {
  const subscriptions = await getTableSubscriptions(schemaName);

  return {
    totalTables: subscriptions.length,
    enabledTables: subscriptions.filter((s) => s.enabled).length,
    disabledTables: subscriptions.filter((s) => !s.enabled).length,
  };
}

/**
 * 配置表订阅（通过 Hasura track 和权限配置）
 */
export async function configureTableSubscription(
  schemaName: string,
  tableName: string,
  enabled: boolean,
  role: string = 'user'
): Promise<TableSubscription> {
  validateSchemaName(schemaName);
  validateTableName(tableName);

  // 验证角色
  if (!validateRole(role)) {
    throw new Error(`Invalid role: ${role}. Allowed roles: ${ALLOWED_ROLES.join(', ')}`);
  }

  if (enabled) {
    // 1. 先 track 表（如果尚未 track）
    try {
      await hasuraMetadataRequest('pg_track_table', {
        source: 'default',
        table: { schema: schemaName, name: tableName },
      });
    } catch (error) {
      // 如果表已经 track，忽略错误
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes('already tracked') && !errorMsg.includes('already exists')) {
        throw error;
      }
    }

    // 2. 添加 select 权限以启用订阅
    try {
      await hasuraMetadataRequest('pg_create_select_permission', {
        source: 'default',
        table: { schema: schemaName, name: tableName },
        role,
        permission: {
          columns: '*',
          filter: {},
          allow_aggregations: false,
        },
      });
    } catch (error) {
      // 如果权限已存在，忽略错误
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes('already exists')) {
        throw error;
      }
    }
  } else {
    // 删除权限以禁用订阅
    try {
      await hasuraMetadataRequest('pg_drop_select_permission', {
        source: 'default',
        table: { schema: schemaName, name: tableName },
        role,
      });
    } catch (error) {
      // 如果权限不存在，忽略错误
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes('does not exist')) {
        throw error;
      }
    }
    // 注意：不 untrack 表，因为可能有其他角色在使用
  }

  return {
    tableName,
    schemaName,
    enabled,
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    hasSelectPermission: enabled,
  };
}

// ============================================
// Realtime Configuration
// ============================================

/**
 * 获取实时配置信息
 */
export function getRealtimeConfig(schemaName: string): RealtimeConfig {
  const wsProtocol = config.hasura.endpoint.startsWith('https') ? 'wss' : 'ws';
  const wsEndpoint = config.hasura.endpoint.replace(/^https?/, wsProtocol);

  return {
    schemaName,
    websocketEndpoint: `${wsEndpoint}/v1/graphql`,
    graphqlEndpoint: HASURA_GRAPHQL_URL,
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

  // JavaScript 客户端示例
  const jsCode = `import { createClient } from 'graphql-ws';

const client = createClient({
  url: '${getRealtimeConfig(schemaName).websocketEndpoint}',
  connectionParams: {
    headers: {
      'x-hasura-admin-secret': 'YOUR_ADMIN_SECRET',
      // 或使用 JWT: 'Authorization': 'Bearer YOUR_JWT_TOKEN'
    },
  },
});

// 订阅表变更
const unsubscribe = client.subscribe(
  {
    query: \`
      subscription {
        ${fullTableName}(order_by: {created_at: desc}, limit: 10) {
          id
          created_at
          updated_at
        }
      }
    \`,
  },
  {
    next: (data) => console.log('收到数据:', data),
    error: (err) => console.error('订阅错误:', err),
    complete: () => console.log('订阅完成'),
  }
);

// 取消订阅
// unsubscribe();`;

  return [
    {
      language: 'graphql',
      code: graphqlCode,
      description: 'GraphQL 订阅查询',
    },
    {
      language: 'javascript',
      code: jsCode,
      description: 'JavaScript 客户端示例 (graphql-ws)',
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
 * 允许的 Hasura 角色列表
 */
const ALLOWED_ROLES = ['user', 'anonymous', 'authenticated'] as const;
type AllowedRole = (typeof ALLOWED_ROLES)[number];

/**
 * 验证角色名称，防止权限提升
 */
function validateRole(role: string): role is AllowedRole {
  return ALLOWED_ROLES.includes(role as AllowedRole);
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
