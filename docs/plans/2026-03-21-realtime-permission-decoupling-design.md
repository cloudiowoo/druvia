# Realtime 权限解耦设计

## 问题

Tables 页面的"同步 GraphQL 权限"给 `user` 和 `anonymous` 两个角色都创建 `select_permission`。Realtime 页面用 `select_permission` 是否存在来判断表是否"启用 realtime"。结果：同步权限后所有表都显示为已启用 realtime，无法单独控制。

关闭 realtime 时会 drop `select_permission`，这又会影响 GraphQL 查询能力。两个功能耦合在同一个 Hasura 权限上。

## 方案

利用现有架构的角色差异实现解耦：

- GraphQL query/mutation 走 API proxy + `x-hasura-admin-secret`，不受角色权限限制
- Subscription 直连 Hasura，走 `anonymous` 角色（SDK `connection_init` 传空 payload，Hasura 分配 `UNAUTHORIZED_ROLE: anonymous`）

因此：Tables 页面只管 `user` 角色权限，Realtime 页面只管 `anonymous` 的 `select_permission`。两个页面操作不同角色，互不干扰。

同时在 `_meta_tables` 中增加 `realtime_enabled` 字段作为持久化标记，Realtime 页面读写此字段，并同步操作 Hasura `anonymous` 角色的 `select_permission`。

## 改动范围

### 1. 数据库迁移（014）

`_meta_tables` 是 per-schema 表（每个租户/项目 schema 各有一份），迁移必须遍历所有 schema。

up 迁移使用 PL/pgSQL 动态执行：

```sql
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT schema_name FROM druvia_schema_registry
  LOOP
    EXECUTE format(
      'ALTER TABLE %I._meta_tables ADD COLUMN IF NOT EXISTS realtime_enabled BOOLEAN NOT NULL DEFAULT false',
      r.schema_name
    );
  END LOOP;
END $$;
```

down 迁移：同样遍历所有 schema，`DROP COLUMN IF EXISTS realtime_enabled`。

Bootstrap 检测：在 `migrate.ts` 的 `dataChecks`（非 `tableChecks`）中添加检查，查询 `information_schema.columns` 确认任意 `_meta_tables` 是否有 `realtime_enabled` 列。

注意：迁移不操作 Hasura metadata。已有表的 `anonymous` select_permission 状态保持不变。管理员应在迁移后到 Tables 页面点"同步 GraphQL 权限"来清理旧的 anonymous select_permission（见第 3 节）。

### 2. Schema 建表 DDL

`schema.service.ts` 中 `createProjectSchema` 和 `createTenantSchema` 的 `_meta_tables` 建表语句增加 `realtime_enabled` 列：

```sql
CREATE TABLE IF NOT EXISTS "<schema>"._meta_tables (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(128) NOT NULL UNIQUE,
  description TEXT,
  row_count BIGINT DEFAULT 0,
  realtime_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
)
```

### 3. table.service.ts

`trackTableInHasura(schemaName, tableName)`：
- `user` 角色：保持不变，创建 select/insert/update/delete 全部权限
- `anonymous` 角色：只创建 insert/update/delete，**不创建 select_permission**

`trackAllTablesInHasura(schemaName)`：
- 同上，遍历所有表时 `anonymous` 不创建 select_permission
- 额外：查询 `_meta_tables` 获取每张表的 `realtime_enabled` 状态，对 `realtime_enabled=false` 的表执行 `pg_drop_select_permission`（anonymous 角色），清理历史遗留权限

`createTable`：无额外改动（调用 `trackTableInHasura` 即可，新表默认不可订阅）

`dropTable`：无改动（`pg_untrack_table` cascade 自动清理）

### 4. realtime.service.ts

`getTableSubscriptions(schemaName)`：
- 使用 LEFT JOIN 合并 `information_schema.tables` 和 `_meta_tables`，保留未在 `_meta_tables` 注册的表（默认 `realtime_enabled=false`）
- `enabled` 字段直接使用 `COALESCE(realtime_enabled, false)`
- 不再调用 Hasura `export_metadata`（前端未使用 `hasSelectPermission` 字段，去掉可简化实现并提升性能）

```sql
SELECT t.table_name, COALESCE(m.realtime_enabled, false) as realtime_enabled
FROM information_schema.tables t
LEFT JOIN "<schema>"._meta_tables m ON m.table_name = t.table_name
WHERE t.table_schema = $1
  AND t.table_type = 'BASE TABLE'
  AND t.table_name NOT LIKE '\_%'
ORDER BY t.table_name
```

```typescript
// 改后：不再调用 Hasura metadata
return {
  tableName,
  schemaName,
  enabled: row.realtime_enabled,
  operations: ['INSERT', 'UPDATE', 'DELETE'],
  hasSelectPermission: row.realtime_enabled,  // 与 enabled 保持一致
};
```

`configureTableSubscription(schemaName, tableName, enabled)`：
- 移除 `role` 参数，固定操作 `anonymous` 角色
- 更新 `_meta_tables.realtime_enabled`
- 开启时：给 `anonymous` 角色创建 `select_permission`（先 track 表，再加权限）
- 关闭时：drop `anonymous` 角色的 `select_permission`
- 不再操作 `user` 角色的任何权限

```typescript
// 改前：接受 role 参数，默认 'user'
role: string = 'user'
// 改后：固定操作 anonymous 角色，移除 role 参数
const REALTIME_ROLE = 'anonymous';
```

### 4.1 realtime.controller.ts

- `ConfigureSubscriptionBody` 接口移除 `role` 字段
- controller 不再从 request.body 解构 `role`
- 移除 `ALLOWED_ROLES` 验证逻辑（不再需要）

### 5. 前端

`apps/admin/src/lib/api.ts`：`configureRealtimeSubscription` 方法移除 `role` 参数（当前前端未传 role，但类型定义中有 `role?: string`，需清理）。

Realtime 页面组件无改动。API 返回的 `TableSubscription` 接口不变，`enabled` 字段语义不变。

### 6. SDK

无改动。subscription 直连 Hasura 走 anonymous 角色，权限由 Hasura metadata 控制。

## 数据流

### GraphQL 查询（不受影响）
```
SDK client.from('table').select()
  → API proxy (POST /projects/:id/graphql)
    → Hasura (x-hasura-admin-secret)
      → 绕过所有角色权限，直接执行
```

### Subscription（受 realtime_enabled 控制）
```
SDK channel().on().subscribe()
  → WebSocket 直连 Hasura (ws://host:8080/v1/graphql)
    → connection_init { payload: {} }
      → Hasura 分配 anonymous 角色
        → 检查 anonymous 的 select_permission
          → 有权限：订阅成功
          → 无权限：报错拒绝
```

### Realtime 页面开启
```
Admin UI toggle ON
  → POST /api/v1/projects/:id/realtime/subscriptions/:table { enabled: true }
    → UPDATE _meta_tables SET realtime_enabled = true
    → pg_track_table (if not tracked)
    → pg_create_select_permission (anonymous role)
```

### Realtime 页面关闭
```
Admin UI toggle OFF
  → POST /api/v1/projects/:id/realtime/subscriptions/:table { enabled: false }
    → UPDATE _meta_tables SET realtime_enabled = false
    → pg_drop_select_permission (anonymous role)
```

## 影响矩阵

| 功能 | 改前 | 改后 | 影响 |
|------|------|------|------|
| Tables: Track | 不变 | 不变 | 无 |
| Tables: Relationship | 不变 | 不变 | 无 |
| Tables: 同步 GraphQL 权限 | user+anonymous 全部权限 | user 全部权限，anonymous 不含 select | anonymous select 由 Realtime 管 |
| Realtime: 查看状态 | 读 Hasura select_permissions | 读 _meta_tables.realtime_enabled | 数据源变更 |
| Realtime: 开启 | 给 user 加 select_permission | 给 anonymous 加 select_permission + 更新 _meta_tables | 操作角色变更 |
| Realtime: 关闭 | drop user 的 select_permission | drop anonymous 的 select_permission + 更新 _meta_tables | 不再影响查询 |
| SDK GraphQL 查询 | 走 admin-secret proxy | 不变 | 无 |
| SDK Subscription | anonymous 角色，所有表可订阅 | anonymous 角色，仅 realtime_enabled 表可订阅 | 预期行为 |
| 新建表 | 自动可订阅 | 默认不可订阅 | 需手动开启 |

## 边界情况

1. **已有表迁移后状态**：所有表 `realtime_enabled=false`，但 Hasura 中 `anonymous` 可能已有 `select_permission`。管理员应在迁移后到 Tables 页面点"同步 GraphQL 权限"来清理。在清理之前，已有表的 subscription 仍可用（`_meta_tables` 显示"未启用"但实际可订阅）。这是已知的一次性不一致，文档中应提示管理员操作。
2. **手动操作 Hasura console**：如果管理员直接在 Hasura console 给 anonymous 加了 select_permission，`_meta_tables.realtime_enabled` 不会同步。这是可接受的——Hasura console 是高级操作，管理员应知道后果。
3. **环境克隆**：`_meta_tables` 随 schema 克隆，`realtime_enabled` 值会被复制。Hasura 权限需要在克隆后通过"同步 GraphQL 权限"重建。

## 文件清单

| 文件 | 改动类型 |
|------|----------|
| `migrations/014_meta_tables_realtime_enabled.up.sql` | 新建 |
| `migrations/014_meta_tables_realtime_enabled.down.sql` | 新建 |
| `apps/api/src/cli/migrate.ts` | 修改（bootstrap dataChecks 加 014 检测） |
| `apps/api/src/modules/schema/schema.service.ts` | 修改（DDL 加列） |
| `apps/api/src/modules/table/table.service.ts` | 修改（anonymous 权限逻辑） |
| `apps/api/src/modules/realtime/realtime.service.ts` | 修改（读写 _meta_tables，移除 role 参数） |
| `apps/api/src/modules/realtime/realtime.controller.ts` | 修改（移除 role 参数和验证） |
| `apps/admin/src/lib/api.ts` | 修改（移除 role 类型定义） |
| `tests/integration/realtime.test.ts` | 修改（移除 role 验证测试，更新断言） |
| `tests/integration/table.test.ts` | 修改（_meta_tables DDL 加列） |
| `tests/integration/svar-datagrid.test.ts` | 修改（_meta_tables DDL 加列） |
