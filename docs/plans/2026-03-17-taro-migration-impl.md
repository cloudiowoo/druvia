# Taro 小程序端迁移 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 taro-app 小程序端从 Supabase 迁移到 Druvia，验证 SDK + RPC + Edge Functions 全链路可用。

**Architecture:** 替换 `supabase-wechat-stable-v2` 为 `@druvia/sdk`，Auth 通过 `druvia.functions.invoke()` 调用迁移后的 Edge Functions，CRUD/Storage/Realtime 使用 SDK 原生 API，RPC 通过 `druvia.rpc()` 调用。

**Tech Stack:** Taro 4.x, @druvia/sdk, TypeScript

**Spec:** `docs/plans/2026-03-17-taro-app-migration-design.md` sections 七 (7.1–7.4)

**Depends on:** Plan 1 (@druvia/sdk), Plan 2 (RPC + Edge Functions)

**Target repo:** `/Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app`

---

## 前置条件

- [ ] Plan 1 (@druvia/sdk) 已实施，`@druvia/sdk` 包可用
- [ ] Plan 2 (RPC + Edge Functions) 已实施，RPC 代理 + Deno.serve() handler 可用
- [ ] Druvia 开发环境已启动（`make dev-up && pnpm dev`）
- [ ] 已在 Druvia Admin 中创建项目（如 `taro-app`），schema 为 `dru_taroapp`

---

## Chunk 1: 数据迁移 — Supabase → Druvia PostgreSQL

### Task 1: 导出 Supabase 表结构与数据

**背景:** 从 Supabase PostgreSQL 导出 public schema 的表结构、PG 函数、数据，准备导入 Druvia。

- [ ] **Step 1: 导出表结构（schema-only）**

```bash
# 从 Supabase 导出 public schema 表结构（不含 auth/storage 等系统 schema）
pg_dump --host=<SUPABASE_DB_HOST> --port=5432 --username=postgres \
  --schema=public --schema-only --no-owner --no-privileges \
  --file=supabase_schema.sql <SUPABASE_DB_NAME>
```

- [ ] **Step 2: 导出 PG 函数定义**

```bash
# 单独导出函数（包含 RPC 用到的所有函数）
pg_dump --host=<SUPABASE_DB_HOST> --port=5432 --username=postgres \
  --schema=public --schema-only --no-owner --no-privileges \
  --section=pre-data --file=supabase_functions.sql <SUPABASE_DB_NAME>
```

从 `supabase_functions.sql` 中提取 `CREATE FUNCTION` 语句，确认包含：
- `join_position_transaction` — Taro 端 RPC 调用

- [ ] **Step 3: 导出数据**

```bash
pg_dump --host=<SUPABASE_DB_HOST> --port=5432 --username=postgres \
  --schema=public --data-only --no-owner \
  --file=supabase_data.sql <SUPABASE_DB_NAME>
```

---

### Task 2: 导入到 Druvia PostgreSQL

**背景:** 将导出的表结构、函数、数据导入 Druvia 的 `dru_taroapp` schema。

- [ ] **Step 1: 调整 schema 引用**

用文本替换将 SQL 文件中的 `public.` 引用改为 `dru_taroapp.`：

```bash
# 表结构：替换 schema 名
sed -i '' 's/SET search_path = public/SET search_path = dru_taroapp/g' supabase_schema.sql
sed -i '' 's/CREATE TABLE public\./CREATE TABLE dru_taroapp./g' supabase_schema.sql
sed -i '' 's/ALTER TABLE ONLY public\./ALTER TABLE ONLY dru_taroapp./g' supabase_schema.sql
sed -i '' 's/REFERENCES public\./REFERENCES dru_taroapp./g' supabase_schema.sql

# 函数：替换 schema 名
sed -i '' 's/CREATE.*FUNCTION public\./CREATE OR REPLACE FUNCTION dru_taroapp./g' supabase_functions.sql
sed -i '' 's/public\./dru_taroapp./g' supabase_functions.sql

# 数据：替换 schema 名
sed -i '' 's/COPY public\./COPY dru_taroapp./g' supabase_data.sql
```

手动检查替换结果，确认无遗漏的 `public.` 引用。

- [ ] **Step 2: 导入表结构**

```bash
psql -h localhost -p 5432 -U postgres -d druvia -f supabase_schema.sql
```

Expected: 表创建成功，无错误

- [ ] **Step 3: 导入 PG 函数**

```bash
psql -h localhost -p 5432 -U postgres -d druvia -f supabase_functions.sql
```

Expected: 函数创建成功

- [ ] **Step 4: 导入数据**

```bash
psql -h localhost -p 5432 -U postgres -d druvia -f supabase_data.sql
```

- [ ] **Step 5: 重置序列**

```sql
-- 连接 Druvia PostgreSQL，对每个有自增主键的表执行
-- 示例（需根据实际表名调整）：
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, columnname, pg_get_serial_sequence(schemaname || '.' || tablename, columnname) AS seq
    FROM pg_catalog.pg_statio_all_sequences s
    JOIN information_schema.columns c ON c.column_default LIKE '%' || s.relname || '%'
    WHERE schemaname = 'dru_taroapp'
  LOOP
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I.%I), 1))', r.seq, r.columnname, r.schemaname, r.tablename);
  END LOOP;
END $$;
```

- [ ] **Step 6: Hasura 表追踪**

通过 Druvia Admin 或 API 调用 `trackTableInHasura()` 注册所有导入的表：

```bash
# 列出 dru_taroapp 下所有表
psql -h localhost -p 5432 -U postgres -d druvia -c \
  "SELECT tablename FROM pg_tables WHERE schemaname = 'dru_taroapp';"

# 通过 Druvia API 逐个 track（或在 Admin 界面操作）
curl -X POST http://localhost:3001/api/v1/projects/<projectId>/tables/track \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"tableName": "<table_name>"}'
```

- [ ] **Step 7: 验证数据完整性**

```bash
# 对比 Supabase 和 Druvia 的行数
psql -h localhost -p 5432 -U postgres -d druvia -c \
  "SELECT tablename, n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'dru_taroapp' ORDER BY tablename;"
```

---

### Task 3: Edge Functions 部署

**背景:** 将 taro-app 的 7 个 Edge Functions 从 Supabase 迁移到 Druvia Deno Worker。

**Files (taro-app repo):**
- Read: `supabase/functions/wx-silent-login/index.ts`
- Read: `supabase/functions/wx-login-register/index.ts`
- Read: `supabase/functions/wx-auth/index.ts`
- Read: `supabase/functions/wx-auth-fixed/index.ts`
- Read: `supabase/functions/upload-avatar/index.ts`
- Read: `supabase/functions/upload-team-logo/index.ts`
- Read: `supabase/functions/admin-recalculate-combo/index.ts`

- [ ] **Step 1: 逐个改写 Edge Function 代码**

每个函数需要做以下替换：

```typescript
// Before (Supabase)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// After (Druvia)
// 注意：@druvia/sdk 是本地包，不在 esm.sh 上。
// Edge Function 代码存储在 druvia_functions 表中，由 Deno Worker 内联执行。
// SDK 不可用于 Worker 内部 — 改为直接调用 Druvia REST API：
const DRUVIA_URL = Deno.env.get('DRUVIA_URL')!
const DRUVIA_KEY = Deno.env.get('DRUVIA_SERVICE_ROLE_KEY')!
const PROJECT_ID = Deno.env.get('DRUVIA_PROJECT_ID')!

// CRUD 示例：直接调用 Hasura GraphQL
async function druviaQuery(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`${DRUVIA_URL}/v1/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': DRUVIA_KEY,
    },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}
```

> **替代方案：** 如果后续将 `@druvia/sdk` 发布到 npm/jsr，则可改回 `import { createClient } from 'https://esm.sh/@druvia/sdk'`。当前阶段使用直接 REST/GraphQL 调用。

CRUD 调用语法基本不变（`from().select().eq()` 等），仅替换变量名 `supabase` → `druvia`。

Storage 调用路径不变：`druvia.storage.from('team-assets').upload(...)`

- [ ] **Step 2: 通过 Druvia API 部署每个函数**

```bash
# 对每个函数执行（以 wx-silent-login 为例）
curl -X POST http://localhost:3001/api/v1/projects/<projectId>/functions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "wx-silent-login",
    "code": "<改写后的函数代码>",
    "secrets": {
      "DRUVIA_URL": "http://localhost:3001",
      "DRUVIA_SERVICE_ROLE_KEY": "<service_role_key>",
      "DRUVIA_PROJECT_ID": "<projectId>",
      "WX_APPID": "<wx_appid>",
      "WX_SECRET": "<wx_secret>"
    }
  }'
```

重复部署所有 7 个函数。

- [ ] **Step 3: 验证 Edge Functions**

```bash
# 测试 wx-silent-login
curl -X POST http://localhost:3001/api/v1/projects/<projectId>/functions/wx-silent-login/invoke \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"body": {"code": "test_wx_code"}}'

# Expected: 返回微信 API 错误（因为 test code 无效），但证明链路通畅
```

---

### Task 4: Storage 文件迁移

- [ ] **Step 1: 从 Supabase Storage 下载文件**

```bash
# 使用 Supabase CLI 或直接 API 下载 team-assets bucket 所有文件
# 方式 1: Supabase CLI
supabase storage ls team-assets --project-ref <ref>

# 方式 2: 手动下载（如果文件不多）
# 列出文件 → 逐个下载
```

- [ ] **Step 2: 上传到 Druvia Storage**

```bash
# 通过 Druvia API 上传
curl -X POST http://localhost:3001/api/v1/projects/<projectId>/storage/team-assets/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@<local_file_path>" \
  -F "path=<original_path>"
```

---

## Chunk 2: Taro 端代码迁移

### Task 5: 环境配置替换

**Files (taro-app repo):**
- Modify: `src/config/env.ts`
- Modify: `src/config/shared.ts`
- Modify: `.env` / `.env.local`（Taro defineConstants 配置）

- [ ] **Step 1: 更新 env.ts**

替换所有 `SUPABASE_*` 环境变量为 `DRUVIA_*`：

```typescript
// src/config/env.ts
const checkAndLogEnvVars = () => {
  const vars = {
    DRUVIA_ENV: typeof process !== 'undefined' && process.env?.DRUVIA_ENV || 'production',
    DRUVIA_URL: typeof process !== 'undefined' && process.env?.DRUVIA_URL || 'http://localhost:3001',
    DRUVIA_API_KEY: typeof process !== 'undefined' && process.env?.DRUVIA_API_KEY || '',
    DRUVIA_PROJECT_ID: typeof process !== 'undefined' && process.env?.DRUVIA_PROJECT_ID || '',
    API_BASE_URL: typeof process !== 'undefined' && process.env?.API_BASE_URL || 'https://api.example.com',
    WX_APPID: typeof process !== 'undefined' && process.env?.WX_APPID || '',
    NODE_ENV: typeof process !== 'undefined' && process.env?.NODE_ENV || 'development'
  };

  console.log('[环境变量检查]', Object.entries(vars)
    .map(([key, value]) => `${key}: ${value ? '已设置' : '使用默认值'}`)
    .join(', ')
  );

  return vars;
};

const ENV_VARS = checkAndLogEnvVars();

export const ENV = {
  DRUVIA_ENV: ENV_VARS.DRUVIA_ENV,
  DRUVIA_URL: ENV_VARS.DRUVIA_URL,
  DRUVIA_API_KEY: ENV_VARS.DRUVIA_API_KEY,
  DRUVIA_PROJECT_ID: ENV_VARS.DRUVIA_PROJECT_ID,
  API_BASE_URL: ENV_VARS.API_BASE_URL,
  WX_APPID: ENV_VARS.WX_APPID,
  ENV_NAME: ENV_VARS.NODE_ENV,
  IS_DEV: ENV_VARS.NODE_ENV === 'development',
  IS_PROD: ENV_VARS.NODE_ENV === 'production',
};

export const getEnvValue = (key: keyof typeof ENV): string => {
  return typeof ENV[key] === 'string' ? ENV[key] as string : '';
};
```

- [ ] **Step 2: 更新 shared.ts**

```typescript
// src/config/shared.ts
import { ENV } from './env';

export const SPORT_TYPES = [
  { label: '足球', value: 'football' },
  { label: '篮球', value: 'basketball' },
  { label: '排球', value: 'volleyball' },
  { label: '其他', value: 'other' }
];

export const ACTIVITY_STATUS = {
  PLANNED: 'planned',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
};

export const getEnv = (key: string): string => {
  switch (key) {
    case 'DRUVIA_URL':
      return ENV.DRUVIA_URL;
    case 'DRUVIA_API_KEY':
      return ENV.DRUVIA_API_KEY;
    case 'DRUVIA_PROJECT_ID':
      return ENV.DRUVIA_PROJECT_ID;
    case 'WX_APPID':
      return ENV.WX_APPID;
    case 'API_BASE_URL':
      return ENV.API_BASE_URL;
    case 'NODE_ENV':
      return ENV.ENV_NAME;
    default:
      console.warn(`未定义环境变量: ${key}`);
      return '';
  }
};

export const getDruviaConfig = () => ({
  url: getEnv('DRUVIA_URL'),
  apiKey: getEnv('DRUVIA_API_KEY'),
  projectId: getEnv('DRUVIA_PROJECT_ID'),
});
```

- [ ] **Step 3: 更新 Taro defineConstants 配置**

在 `config/index.ts` 或 `.env` 中更新编译时注入的常量名。

- [ ] **Step 4: 验证编译通过**

Run: `cd /Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app && pnpm build:weapp`
Expected: 编译成功（此时 supabase import 会报错，后续 Task 修复）

---

### Task 6: 客户端初始化替换

**Files (taro-app repo):**
- Modify: `src/services/supabase.ts` → 重命名为 `src/services/druvia.ts`
- Modify: `src/services/wechat-storage.ts`（保留，作为 SDK adapter）
- Modify: `package.json`（替换依赖）

- [ ] **Step 1: 替换依赖**

```bash
cd /Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app
pnpm remove supabase-wechat-stable-v2
pnpm add @druvia/sdk@workspace:*  # 或 link 到本地 SDK
```

- [ ] **Step 2: 创建 `src/services/druvia.ts`**

替换原 `supabase.ts`，使用 `@druvia/sdk`：

```typescript
// src/services/druvia.ts
import { createClient } from '@druvia/sdk'
import { wechatStorageAdapter } from './wechat-storage'
import { getDruviaConfig } from '../config/shared'
import Taro from '@tarojs/taro'

const config = getDruviaConfig()

// 存储桶名称
export const STORAGE_BUCKETS = {
  TEAM_ASSETS: 'team-assets',
  PUBLIC: 'public',
}

// Druvia 客户端单例
let druviaInstance: ReturnType<typeof createClient> | null = null

/**
 * 获取 Druvia 客户端
 */
export const getDruvia = () => {
  if (!druviaInstance) {
    druviaInstance = createClient(config.url, config.apiKey, {
      projectId: config.projectId,
      // Taro fetch 适配
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const res = await Taro.request({
          url,
          method: (init?.method as any) || 'GET',
          data: init?.body,
          header: init?.headers as Record<string, string>,
        })
        return {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: new Map(Object.entries(res.header || {})),
          json: async () => typeof res.data === 'string' ? JSON.parse(res.data) : res.data,
          text: async () => typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
        } as any
      },
      // localStorage 适配
      storage: wechatStorageAdapter,
      // WebSocket 适配
      websocket: (url: string, protocols?: string[]) => {
        const task = Taro.connectSocket({ url, protocols })
        return {
          onOpen: (cb: () => void) => task.onOpen(cb),
          onMessage: (cb: (data: any) => void) => task.onMessage((res: any) => cb(res.data)),
          onClose: (cb: () => void) => task.onClose(cb),
          onError: (cb: (err: any) => void) => task.onError(cb),
          send: (data: string) => task.send({ data }),
          close: () => task.close({}),
        }
      }
    })
  }
  return druviaInstance
}

// 兼容旧代码的别名（逐步替换后移除）
export const getSupabase = getDruvia
```

- [ ] **Step 3: 更新 wechat-storage.ts 的 import**

```typescript
// src/services/wechat-storage.ts
import Taro from '@tarojs/taro'

// StorageAdapter 接口与 @druvia/sdk 的 storage 选项兼容
export const wechatStorageAdapter = {
  getItem: (key: string) => {
    try { return Taro.getStorageSync(key) }
    catch { return null }
  },
  setItem: (key: string, value: string) => {
    try { Taro.setStorageSync(key, value) }
    catch (e) { console.error('设置存储失败:', e) }
  },
  removeItem: (key: string) => {
    try { Taro.removeStorageSync(key) }
    catch (e) { console.error('删除存储失败:', e) }
  }
}
```

- [ ] **Step 4: 全局替换 import 引用**

在整个 `src/` 目录中：
- `import { getSupabase } from './supabase'` → `import { getDruvia } from './druvia'`
- `import { getSupabase } from '../services/supabase'` → `import { getDruvia } from '../services/druvia'`
- 所有 `getSupabase()` 调用 → `getDruvia()`
- 所有 `supabase.` 变量名 → `druvia.`

```bash
# 查找所有引用
grep -rn "getSupabase\|from.*supabase\|supabase-wechat" src/ --include="*.ts" --include="*.tsx"
```

---

### Task 7: Auth 服务迁移

**Files (taro-app repo):**
- Modify: `src/services/auth.ts`

**背景:** taro-app 的微信登录通过 Edge Functions 实现，不使用 Supabase Auth SDK。auth.ts 中直接用 `Taro.request()` 调用 Supabase Edge Function URL。迁移后改为 `druvia.functions.invoke()`。

- [ ] **Step 1: 替换 Edge Function 调用方式**

在 `auth.ts` 中找到所有 `Taro.request` 调用 Supabase Edge Function 的地方，替换为：

```typescript
// Before
const response = await Taro.request({
  url: `${supabaseUrl}/functions/v1/wx-silent-login`,
  method: 'POST',
  header: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${supabaseKey}`,
  },
  data: { code: wxCode }
})

// After
import { getDruvia } from './druvia'

const druvia = getDruvia()
const { data, error } = await druvia.functions.invoke('wx-silent-login', {
  body: { code: wxCode }
})
```

对以下函数调用逐个替换：
- `wx-silent-login` — 静默登录
- `wx-login-register` — 注册
- `wx-auth` / `wx-auth-fixed` — 认证

- [ ] **Step 2: 替换 session 管理**

auth.ts 中的 session 存储逻辑（`sb-session` key 等）改为 Druvia token 管理：

```typescript
// Before: Supabase session
Taro.setStorageSync('sb-session', JSON.stringify(session))

// After: Druvia token（SDK 内部管理，auth.ts 只需存 user 信息）
Taro.setStorageSync('user_data', JSON.stringify(user))
```

- [ ] **Step 3: 替换 CRUD 调用**

auth.ts 中的 `supabase.from('users').select(...)` 等调用替换为 `druvia.from('users').select(...)`。

链式 API 语法相同，仅替换客户端变量名。

---

### Task 8: CRUD 服务迁移

**Files (taro-app repo):**
- Modify: `src/services/supabase.ts` 中的 storageService 和所有 CRUD 函数 → 移入 `src/services/druvia.ts` 或拆分

**背景:** supabase.ts 有 910 行，包含 createClient + 70+ CRUD 操作 + Storage 操作 + 缓存逻辑。SDK 原生 API 的链式调用语法与 Supabase 高度相似。

- [ ] **Step 1: 批量替换 CRUD 调用**

大部分 CRUD 代码只需替换客户端获取方式：

```typescript
// Before
const supabase = getSupabase()
const { data, error } = await supabase
  .from('activities')
  .select('*')
  .eq('status', 'active')
  .order('created_at', { ascending: false })

// After
const druvia = getDruvia()
const { data, error } = await druvia
  .from('activities')
  .select('*')
  .eq('status', 'active')
  .order('created_at', { ascending: false })
```

SDK 支持的链式方法与 Supabase 一致：`from/select/insert/update/delete/upsert/eq/neq/in/order/range/single`

- [ ] **Step 2: 替换 Storage 调用**

```typescript
// Before
const supabase = getSupabase()
await supabase.storage.from('team-assets').upload(path, file)
const { data } = supabase.storage.from('team-assets').getPublicUrl(path)

// After
const druvia = getDruvia()
await druvia.storage.from('team-assets').upload(path, file)
const { data } = druvia.storage.from('team-assets').getPublicUrl(path)
```

- [ ] **Step 3: 替换 RPC 调用**

```typescript
// Before
const { data, error } = await supabase.rpc('join_position_transaction', {
  p_activity_id: activityId,
  p_user_id: userId,
  p_position: position
})

// After
const { data, error } = await druvia.rpc('join_position_transaction', {
  p_activity_id: activityId,
  p_user_id: userId,
  p_position: position
})
```

- [ ] **Step 4: 删除旧 supabase.ts**

确认所有引用已迁移后，删除 `src/services/supabase.ts`。

---

### Task 9: Realtime 迁移

**Files (taro-app repo):**
- Modify: `src/services/maintenance.ts`
- Modify: `src/pages/activity-detail/` 中的 Realtime 订阅

- [ ] **Step 1: 迁移 maintenance.ts 的 Realtime 订阅**

```typescript
// Before
const supabase = getSupabase()
return supabase
  .channel('maintenance_changes')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'system_config',
    filter: 'key=eq.maintenance_mode'
  }, async () => {
    const config = await getMaintenanceConfig(true)
    callback(config.enabled, config)
  })
  .subscribe()

// After
import { getDruvia } from './druvia'

const druvia = getDruvia()
return druvia
  .channel('maintenance_changes')
  .on('postgres_changes', {
    event: '*',
    schema: 'dru_taroapp',  // 注意：schema 从 public 改为 dru_taroapp
    table: 'system_config',
    filter: 'key=eq.maintenance_mode'
  }, async (payload) => {
    const config = await getMaintenanceConfig(true)
    callback(config.enabled, config)
  })
  .subscribe()
```

- [ ] **Step 2: 迁移 maintenance.ts 中所有 CRUD 调用**

`getMaintenanceConfig`、`updateMaintenanceConfig`、`checkIfUserIsAdmin` 中的 `getSupabase()` → `getDruvia()`。

- [ ] **Step 3: 迁移 activity-detail 页面的 Realtime**

找到 activity-detail 中的 subscription 代码，同样替换 channel + schema。

---

## Chunk 3: 验证与清理

### Task 10: 编译验证

- [ ] **Step 1: TypeScript 编译检查**

```bash
cd /Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app
npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 2: 小程序构建**

```bash
pnpm build:weapp
```

Expected: 构建成功

- [ ] **Step 3: 搜索残留的 Supabase 引用**

```bash
grep -rn "supabase\|SUPABASE" src/ --include="*.ts" --include="*.tsx" | grep -v "node_modules"
```

Expected: 无结果（或仅注释中的历史说明）

### Task 11: 功能验证

按 spec 7.4 验证标准逐项测试：

- [ ] **Step 1: 微信小程序正常启动**

在微信开发者工具中打开项目，确认首页加载正常。

- [ ] **Step 2: 微信登录流程**

测试静默登录 → 注册新用户 → 登录已有用户。

- [ ] **Step 3: CRUD 操作**

测试活动列表查询、创建活动、更新活动。

- [ ] **Step 4: Storage 操作**

测试头像上传、Logo 上传、图片显示。

- [ ] **Step 5: Realtime 订阅**

测试维护模式实时通知。

- [ ] **Step 6: RPC 调用**

测试加入活动（`join_position_transaction`）。

---

## Summary

| Chunk | Task | 说明 |
|-------|------|------|
| 1 | Task 1 | 导出 Supabase 表结构/函数/数据 |
| 1 | Task 2 | 导入 Druvia PostgreSQL + Hasura track |
| 1 | Task 3 | 7 个 Edge Functions 改写 + 部署 |
| 1 | Task 4 | Storage 文件迁移 |
| 2 | Task 5 | 环境配置替换（env.ts / shared.ts） |
| 2 | Task 6 | 客户端初始化替换（supabase.ts → druvia.ts） |
| 2 | Task 7 | Auth 服务迁移（Edge Function 调用方式） |
| 2 | Task 8 | CRUD/Storage/RPC 批量替换 |
| 2 | Task 9 | Realtime 订阅迁移 |
| 3 | Task 10 | 编译验证 + 残留检查 |
| 3 | Task 11 | 功能验证（6 项验收标准） |
