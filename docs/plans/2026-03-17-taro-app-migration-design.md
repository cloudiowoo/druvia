# Taro-App Supabase → Druvia 迁移开发计划

**创建日期**: 2026-03-17
**状态**: 草案
**目标**: 以 taro-app（含 H5 子项目）实际迁移为目标，补齐 Druvia 能力并完成迁移

---

## 一、背景

taro-app 是一个体育/运动统计应用，包含两个独立子项目：
- **Taro 小程序端**：微信小程序，用 `supabase-wechat-stable-v2` 直连 Supabase
- **H5 端**：Next.js 16 Web 应用，30+ API routes，20+ RPC 函数

当前后端完全依赖 Supabase，使用了 Auth、Database CRUD、Storage、Realtime、RPC、Edge Functions 六大能力。

### Supabase 功能使用清单

| 功能 | Taro 端 | H5 端 | Druvia 当前支持 |
|------|---------|-------|----------------|
| Auth（微信小程序） | Edge Function 实现 | username 登录 | ⚠️ 微信 adapter 有，但 EF 不可用 |
| Database CRUD | 70+ 调用，直连 | 30+ API routes | ✅ GraphQL (Hasura) |
| Storage | 头像/Logo 上传 | 图片上传 | ✅ R2/Local |
| Realtime | 2 个 subscription | 无 | ✅ Hasura subscriptions |
| RPC | 1 个函数 | 20+ 函数 | ❌ 无通用 RPC 机制 |
| Edge Functions | 7 个（微信 auth + 上传 + 管理） | 无 | ⚠️ API 层有，Deno Worker 已存在但不支持 Deno.serve() |

---

## 二、关键决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 核心目标 | taro-app 实际迁移 | 作为第一个真实迁移案例验证 |
| SDK 策略 | 原生 API 优先，compat 层后续可选 | 以 Druvia 能力为基准，不绑定 Supabase |
| SDK API 覆盖 | 完整 6 块能力 | 不只为 taro-app，通用设计 |
| RPC 机制 | API 层 RPC 代理 | 直调租户 schema 内 PG 函数 |
| 微信 Auth | 迁移 Edge Functions 到 Druvia | 复用现有 Deno 代码 |
| 迁移顺序 | 先 Taro 端，后 H5 端 | 小程序端依赖更集中 |
| 实现路径 | SDK-First | 先补齐能力再迁移 |

---

## 三、整体架构

```
阶段 1: Druvia 能力补齐          阶段 2: Taro 端迁移
┌─────────────────────────┐    ┌─────────────────────────┐
│ 1a. @druvia/sdk 原生 API │    │ 2a. 微信 Auth 对接       │
│     - auth / query /     │    │ 2b. CRUD 改写            │
│       storage / realtime │    │ 2c. Storage 迁移          │
│       rpc / functions    │    │ 2d. Realtime 迁移         │
│     - 小程序运行时兼容    │    │ 2e. Edge Functions 部署   │
│                         │    │ 2f. 数据迁移              │
│ 1b. RPC 代理端点         │    │                           │
│ 1c. Edge Functions 补齐  │    │ 验证：小程序端功能完整运行 │
│                         │    └─────────────────────────┘
│ 验证：SDK 单元测试通过    │
└─────────────────────────┘    阶段 3: H5 端迁移
                               ┌─────────────────────────┐
阶段 4: 验证与文档              │ 3a. API routes 改写       │
┌─────────────────────────┐    │ 3b. 20+ RPC 函数迁移     │
│ 4a. 端到端集成测试        │    │ 3c. Storage 适配          │
│ 4b. 迁移指南文档          │    │ 3d. Session 管理适配      │
│ 4c. SDK 使用文档          │    │                           │
│ 4d. supabase-compat 更新 │    │ 验证：H5 端功能完整运行    │
└─────────────────────────┘    └─────────────────────────┘
```

依赖关系：阶段 1 → 阶段 2 → 阶段 3 → 阶段 4

---

## 四、阶段 1 — @druvia/sdk 设计

### 4.1 包结构

```
packages/sdk/
├── src/
│   ├── index.ts              # createClient() 入口
│   ├── DruviaClient.ts       # 主客户端类
│   ├── modules/
│   │   ├── auth.ts           # signUp/signIn/signOut/getUser/getSession/onAuthStateChange
│   │   ├── database.ts       # from().select().eq()... 链式查询 → GraphQL
│   │   ├── storage.ts        # upload/download/getPublicUrl/createSignedUrl
│   │   ├── realtime.ts       # subscribe → Hasura GraphQL Subscription (WebSocket)
│   │   ├── rpc.ts            # rpc(name, args) → POST /rpc/:fn
│   │   └── functions.ts      # invoke(name, { body }) → POST /functions/:name/invoke
│   ├── lib/
│   │   ├── graphql-builder.ts  # 链式 API → GraphQL 字符串生成
│   │   ├── fetch-adapter.ts    # 可替换 fetch（浏览器/Node/小程序）
│   │   └── storage-adapter.ts  # 可替换 localStorage
│   └── types/
│       └── index.ts
├── package.json
└── tsconfig.json
```

### 4.2 核心 API

```typescript
import { createClient } from '@druvia/sdk'

const druvia = createClient(url, apiKey, {
  projectId: 'my-project',
  fetch: customFetch,      // 可选，小程序环境传入 Taro.request 适配
  storage: customStorage,  // 可选，小程序环境传入 wechat storage
})

// --- Auth ---
await druvia.auth.signUp({ email, password })
await druvia.auth.signIn({ email, password })          // email + password
await druvia.auth.signIn({ username, password })       // username + password（H5 端使用）
await druvia.auth.signOut()
await druvia.auth.getUser()
await druvia.auth.getSession()
druvia.auth.onAuthStateChange(callback)
// 注意：微信小程序登录走 druvia.functions.invoke('wx-silent-login', { body: { code } })
// 不走 druvia.auth，因为微信 auth 逻辑在 Edge Function 中实现

// --- Database CRUD ---
// 链式 API（Druvia 原生风格，能力对齐 Supabase）
await druvia.from('users').select('*').eq('id', 1).single()
await druvia.from('teams').select('id, name').order('name', { ascending: true })
await druvia.from('activities').select('*').range(0, 19)
await druvia.from('users').insert({ username: 'test', user_id: 'xxx' })
await druvia.from('users').update({ username: 'new' }).eq('id', 1)
await druvia.from('users').delete().eq('id', 1)
await druvia.from('users').upsert({ id: 1, username: 'test' })
// 底层：链式调用 → GraphQL query/mutation → Hasura

// 直接 GraphQL（高级用法）
await druvia.graphql(`query { users(where: {id: {_eq: 1}}) { id name } }`)

// --- RPC ---
await druvia.rpc('confirm_drafts', { match_id: 1 })
await druvia.rpc('calculate_season_aggregation', { season_id: 5 })
// 底层：POST /api/v1/projects/:projectId/rpc/:functionName

// --- Storage ---
await druvia.storage.from('team-assets').upload('avatar.png', file)
await druvia.storage.from('team-assets').download('avatar.png')
druvia.storage.from('team-assets').getPublicUrl('avatar.png')
await druvia.storage.from('team-assets').createSignedUrl('avatar.png', 3600)

// --- Realtime ---
druvia.channel('maintenance_changes')
  .on('postgres_changes', {
    event: '*',
    table: 'system_config',
    filter: 'key=eq.maintenance_mode'
  }, callback)
  .subscribe()
// 底层：Hasura GraphQL Subscription over WebSocket

// --- Edge Functions ---
await druvia.functions.invoke('wx-silent-login', {
  body: { code: 'wx_code_xxx' }
})
// 底层：POST /api/v1/projects/:projectId/functions/:name/invoke
```

### 4.3 Query Builder → GraphQL 转换

SDK 核心模块，将链式调用转换为 Hasura GraphQL：

```typescript
// 输入
druvia.from('activities')
  .select('*, user_activities(*)')
  .eq('status', 'active')
  .order('created_at', { ascending: false })
  .range(0, 19)

// 生成的 GraphQL
query {
  activities(
    where: { status: { _eq: "active" } }
    order_by: { created_at: desc }
    offset: 0
    limit: 20
  ) {
    id, status, created_at
    user_activities { id, user_id, activity_id }
  }
}
```

需支持的操作符（taro-app 实际使用 + 通用补充）：

| 方法 | Hasura 等价 | taro-app 使用 |
|------|-------------|---------------|
| `.eq(col, val)` | `_eq` | ✅ |
| `.neq(col, val)` | `_neq` | ✅ |
| `.in(col, vals)` | `_in` | ✅ |
| `.gt / .gte / .lt / .lte` | `_gt / _gte / _lt / _lte` | 通用 |
| `.like / .ilike` | `_like / _ilike` | 通用 |
| `.is(col, null)` | `_is_null` | 通用 |
| `.order(col, opts)` | `order_by` | ✅ |
| `.range(from, to)` | `offset + limit` | ✅ |
| `.single()` | 取首条 + 断言 | ✅ |
| `.select('*, rel(*)')` | 嵌套查询 | ✅ |

### 4.4 `select('*')` 字段发现机制

Hasura GraphQL 不支持 `SELECT *`，必须显式列出字段名。SDK 需要自动解析：

```
策略：懒加载 introspection + 缓存

1. 首次对某表调用 select('*') 时，SDK 通过 Hasura introspection 查询该表字段：
   query { __type(name: "dru_taroapp_users") { fields { name } } }
   注意：Hasura 的类型名格式为 `<schema>_<table>`（如 dru_taroapp_users），不是简单表名。
   SDK 需要根据 projectId 推导 schema 名，拼接完整类型名。

2. 缓存字段列表到内存（Map<tableName, string[]>）

3. 后续 select('*') 直接使用缓存

4. 缓存失效：
   - SDK 提供 druvia.schema.refresh(tableName?) 手动刷新
   - 可选：createClient 时传入 schemaCache: false 禁用缓存（每次查询都 introspect）

5. 如果 introspection 失败（如权限不足），抛出明确错误提示用户显式列出字段
```

### 4.5 Realtime 语义适配

Supabase Realtime 推送变更事件（INSERT/UPDATE/DELETE），Hasura Subscription 推送查询结果的当前状态。SDK 需要桥接这个语义差异：

```
策略：SDK 维护本地快照，diff 检测变更类型

1. 首次 subscribe 时，记录初始数据快照
2. 每次 subscription 推送新数据时，与快照 diff：
   - 新增的行 → 触发 INSERT 事件
   - 变化的行 → 触发 UPDATE 事件
   - 消失的行 → 触发 DELETE 事件
3. 更新快照

回调签名：
callback({ eventType: 'INSERT' | 'UPDATE' | 'DELETE', new: row, old: row | null })

限制：
- 仅适用于小数据集的订阅（taro-app 的 2 个订阅都是单行/少量行）
- 大数据集订阅建议直接使用 druvia.graphql() 写原生 subscription
```

### 4.6 小程序运行时兼容

不做独立适配器，通过 createClient 选项注入：

```typescript
import Taro from '@tarojs/taro'
import { createClient } from '@druvia/sdk'

const druvia = createClient(url, apiKey, {
  projectId: 'taro-app',
  // fetch 适配：Taro.request 返回 { statusCode, data, header }，需转换为 Response 兼容对象
  fetch: async (input, init) => {
    const res = await Taro.request({ url: input as string, method: init?.method, data: init?.body, header: init?.headers })
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      headers: new Map(Object.entries(res.header || {})),
      json: async () => typeof res.data === 'string' ? JSON.parse(res.data) : res.data,
      text: async () => typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
    } as any
  },
  // localStorage 适配
  storage: {
    getItem: (key) => Taro.getStorageSync(key),
    setItem: (key, value) => Taro.setStorageSync(key, value),
    removeItem: (key) => Taro.removeStorageSync(key),
  },
  // WebSocket 适配：微信小程序使用 wx.connectSocket，非标准 WebSocket
  // websocket 选项为工厂函数 (url, protocols) => WebSocketLike
  websocket: (url, protocols) => {
    const task = Taro.connectSocket({ url, protocols })
    return {
      onOpen: (cb) => task.onOpen(cb),
      onMessage: (cb) => task.onMessage((res) => cb(res.data)),
      onClose: (cb) => task.onClose(cb),
      onError: (cb) => task.onError(cb),
      send: (data) => task.send({ data }),
      close: () => task.close({}),
    }
  }
})
```

SDK 可考虑后续提供 `@druvia/sdk/taro` 预置适配器，封装上述转换逻辑。

---

## 五、阶段 1 — RPC 代理端点

### 5.1 端点设计

```
POST /api/v1/projects/:projectId/rpc/:functionName
Authorization: Bearer <token>
Content-Type: application/json

{ "args": { "match_id": 1, "user_id": "abc" } }

Response:
{ "data": [...], "error": null }
```

### 5.2 实现逻辑

```
请求进入
  → 验证 token + projectId 权限（复用 verifyProjectAccess）
  → 解析 projectId → 项目 schema 名（如 dru_taroapp）
  → 查询 pg_proc 确认函数存在于该 schema
  → 构建调用：SELECT * FROM dru_taroapp."functionName"($1, $2...)
  → 参数通过 $N 参数化传递（防 SQL 注入）
  → 返回结果
```

### 5.3 参数发现与映射

SDK 发送 `{ "args": { "match_id": 1, "user_id": "abc" } }` 为 JSON 对象，RPC 代理需要将命名参数映射到 PG 函数的位置参数：

```
1. 查询函数签名：
   SELECT p.proname, p.proargnames, p.proargtypes
   FROM pg_proc p
   JOIN pg_namespace n ON p.pronamespace = n.oid
   WHERE n.nspname = 'dru_taroapp' AND p.proname = 'functionName'

2. 从 proargnames 获取参数名列表（如 ['match_id', 'user_id']）

3. 按参数名顺序从 args JSON 中提取值，映射到 $1, $2...

4. 缓存函数签名元数据（Map<schemaName.functionName, argNames[]>）
   - 缓存 TTL: 5 分钟，或提供手动刷新端点
```

### 5.4 返回类型处理

PG 函数有多种返回类型，统一包装为 `{ data, error }` 格式：

| PG 返回类型 | 处理方式 | 响应示例 |
|-------------|----------|----------|
| `RETURNS SETOF / TABLE` | 返回数组 | `{ "data": [{...}, {...}], "error": null }` |
| `RETURNS record / composite` | 返回单对象 | `{ "data": {...}, "error": null }` |
| `RETURNS scalar (int, text...)` | 包装为对象 | `{ "data": 42, "error": null }` |
| `RETURNS json / jsonb` | 直接返回 | `{ "data": {...}, "error": null }` |
| `RETURNS void` | 返回 null | `{ "data": null, "error": null }` |

### 5.5 安全约束

- 只允许调用项目自身 schema 内的函数，不能跨 schema
- 函数名通过 pg_proc 验证存在性，防止任意 SQL 执行
- 参数化传递，防注入
- 复用现有 API 限流机制
- 可选：管理员可配置函数白名单（暴露哪些函数给 SDK 调用）

### 5.4 新增文件

```
apps/api/src/modules/rpc/
├── rpc.routes.ts    # 路由注册
└── rpc.service.ts   # 函数发现 + 调用逻辑
```

---

## 六、阶段 1 — Edge Functions 补齐

### 6.1 当前状态

Druvia 的 Edge Functions 模块：
- API 层已完整（CRUD、invoke、logs、schedules）
- Deno Worker 已存在：`docker/deno-worker/main.ts` + `executor.ts`，Docker Compose 中已定义 `deno` 服务
- API 的 `functions.service.ts` 已实现 invoke 流程，通过 `DENO_WORKER_URL` 调用 Worker

但当前 Worker 的执行模型是：将函数代码作为字符串通过 `AsyncFunction` 构造器执行，不支持 `Deno.serve()` 风格的 HTTP handler 模式。taro-app 的 Edge Functions 使用 `Deno.serve(async (req) => {...})` 模式。

### 6.2 需要扩展

```
1. 支持 Deno.serve() handler 模式
   当前：executor.ts 通过 AsyncFunction 执行代码字符串
   目标：支持 Supabase 风格的 Deno.serve() handler
   方案：
   ├── 检测函数代码是否包含 Deno.serve()
   ├── 如果是，提取 handler 函数
   ├── 构造 synthetic Request 对象传入 handler
   ├── 收集 Response 返回给 API 层
   └── 保持向后兼容：原有 AsyncFunction 模式继续支持

2. 函数内 Druvia SDK 上下文
   ├── 函数环境注入 DRUVIA_URL + DRUVIA_SERVICE_ROLE_KEY + DRUVIA_PROJECT_ID
   ├── taro-app 的 wx-login 函数需要用 service_role_key 操作数据库
   └── 函数代码内 import '@druvia/sdk' 需可用（预装或 URL import）

3. 函数文件管理
   ├── 当前：函数代码存储在 druvia_functions 表中，invoke 时内联发送
   ├── 扩展：支持多文件函数（如 taro-app 的函数可能 import 共享模块）
   └── 可选：支持从文件系统加载（开发模式）
```

### 6.3 taro-app Edge Functions 迁移

7 个函数从 Supabase 迁移到 Druvia：

| 函数 | 用途 | 迁移改动 |
|------|------|----------|
| wx-silent-login | 微信静默登录 | import 替换 + createClient 参数 |
| wx-login-register | 微信注册 | 同上 |
| wx-auth | 微信认证 | 同上 |
| wx-auth-fixed | 微信认证（修复版） | 同上 |
| upload-avatar | 头像上传 | 同上 + storage API 路径 |
| upload-team-logo | Logo 上传 | 同上 + storage API 路径 |
| admin-recalculate-combo | 管理员重算组合统计 | 同上 + RPC 调用路径 |

迁移后代码示例：

```typescript
// 迁移后的 wx-silent-login/index.ts
// 注意：@druvia/sdk 是本地包，Deno Worker 内无法 import。
// 使用直接 REST/GraphQL 调用，后续 SDK 发布到 npm/jsr 后可改回 SDK 方式。
const DRUVIA_URL = Deno.env.get('DRUVIA_URL')!
const DRUVIA_KEY = Deno.env.get('DRUVIA_SERVICE_ROLE_KEY')!

async function druviaQuery(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`${DRUVIA_URL}/v1/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hasura-admin-secret': DRUVIA_KEY },
    body: JSON.stringify({ query, variables }),
  })
  return res.json()
}

// Deno.serve() handler 模式 — Worker 需支持此模式
Deno.serve(async (req) => {
  const { code } = await req.json()

  // 用 code 换 openid（微信 API，不变）
  const wxRes = await fetch(`https://api.weixin.qq.com/sns/jscode2session?...&js_code=${code}`)
  const { openid } = await wxRes.json()

  // 查找用户（GraphQL 直调）
  const { data } = await druviaQuery(
    `query($openid: String!) { users(where: { wx_openid: { _eq: $openid } }, limit: 1) { id username wx_openid } }`,
    { openid }
  )
  const user = data?.users?.[0]

  return new Response(JSON.stringify({ user, token }))
})
```

### 6.4 修改文件

```
docker/deno-worker/executor.ts  # 扩展：支持 Deno.serve() handler 模式
docker/deno-worker/main.ts      # 可能需要调整请求转发逻辑
```

注意：`deno` 服务已在 `docker/docker-compose.yml` 中定义，无需新增。

---

## 七、阶段 2 — Taro 小程序端迁移

### 7.1 迁移范围

| 文件 | 依赖内容 | 迁移动作 |
|------|----------|----------|
| `src/services/supabase.ts` (910行) | createClient、CRUD、Storage、缓存 | 替换为 @druvia/sdk，CRUD 改写为原生 API |
| `src/services/auth.ts` (1379行) | Edge Function 调用、session 管理 | druvia.functions.invoke() 替换 Taro.request() |
| `src/services/maintenance.ts` | Realtime subscription | druvia.channel().on().subscribe() |
| `src/services/wechat-storage.ts` | localStorage 适配器 | 作为 SDK storage 选项传入 |
| `src/config/env.ts` / `shared.ts` | SUPABASE_URL/KEY | 改为 DRUVIA_URL/DRUVIA_API_KEY |
| `src/pages/activity-detail/` | Realtime + RPC | channel + rpc 替换 |

### 7.2 迁移步骤

```
Step 1: 环境配置
  .env: SUPABASE_URL → DRUVIA_URL, SUPABASE_KEY → DRUVIA_API_KEY
  新增: DRUVIA_PROJECT_ID
  config/shared.ts: 更新配置读取

Step 2: 客户端初始化
  - import { createClient } from 'supabase-wechat-stable-v2'
  + import { createClient } from '@druvia/sdk'
  传入 Taro fetch 适配 + wechatStorageAdapter

Step 3: CRUD 改写（主要工作量）
  SDK 原生 API 的链式调用语法（from/select/eq/order/range 等）与 Supabase 相似但非 drop-in：
  - 方法签名相同的：from/select/eq/neq/in/order/range/single/insert/update/delete/upsert → 直接替换
  - 返回格式统一为 { data, error }，与 Supabase 一致
  - 差异点：select('*') 需要 SDK introspection 支持（见 4.4）
  实际改动：替换 import + createClient，大部分链式调用代码无需修改

Step 4: Auth
  Edge Function 调用方式变更：
  - Taro.request({ url: `${supabaseUrl}/functions/v1/wx-silent-login` })
  + druvia.functions.invoke('wx-silent-login', { body: { code } })

Step 5: Storage
  - supabase.storage.from('team-assets').upload(...)
  + druvia.storage.from('team-assets').upload(...)

Step 6: Realtime
  - supabase.channel('xxx').on('postgres_changes', ...).subscribe()
  + druvia.channel('xxx').on('postgres_changes', ...).subscribe()

Step 7: RPC
  - supabase.rpc('join_position_transaction', { ... })
  + druvia.rpc('join_position_transaction', { ... })
  需先把 PG 函数导入 Druvia 项目 schema
```

### 7.3 数据迁移

```
1. 在 Druvia 中创建项目
   通过 Admin 界面在 default 租户下创建项目（如 taro-app）
   Druvia 自动创建 schema（如 dru_taroapp）

2. 表结构导入
   pg_dump --schema-only 从 Supabase 导出（public schema）
   调整 schema 引用：public → dru_taroapp
   导入 Druvia PostgreSQL
   调用 Hasura track 注册所有表

3. PG 函数导入
   导出 join_position_transaction 等函数定义
   调整 schema 引用后导入 dru_taroapp

4. 数据导入
   pg_dump --data-only 或 COPY 导出
   导入对应 schema
   重置所有序列：SELECT setval(pg_get_serial_sequence('table','id'), MAX(id)) FROM table
   （避免导入后 INSERT 产生主键冲突）

5. Storage 文件迁移
   从 Supabase Storage 下载 team-assets bucket 所有文件
   上传到 Druvia Storage

6. Edge Functions 部署
   将 7 个 Deno 函数部署到 Druvia Deno Worker
   更新环境变量（DRUVIA_URL、SERVICE_ROLE_KEY、WX_APPID 等）
```

### 7.4 验证标准

- [ ] 微信小程序正常启动
- [ ] 微信登录（静默登录 + 注册）流程正常
- [ ] 活动列表查询、创建、更新正常
- [ ] 头像/Logo 上传下载正常
- [ ] 维护模式实时通知正常
- [ ] 加入活动（RPC: join_position_transaction）正常

---

## 八、阶段 3 — H5 端迁移

### 8.1 H5 端架构特点

H5 是 Next.js 应用，Supabase 调用分两层：
- 服务端：`/h5/src/app/api/` 下 30+ API routes，用 `@supabase/supabase-js` 直连
- 客户端：`/h5/src/utils/supabase.ts` 创建客户端，部分页面直接调用
- 独立 session 管理：username 登录 → 生成 sessionId → 存 `user_sessions` 表

### 8.2 迁移范围

| 文件/目录 | 内容 | 迁移动作 |
|-----------|------|----------|
| `h5/src/utils/supabase.ts` | 客户端初始化 | 替换为 @druvia/sdk |
| `h5/src/utils/auth.ts` | username 登录 + session | CRUD 调用改写 |
| `h5/src/utils/import-service.ts` | 数据导入 + RPC | rpc() 改写 |
| `h5/src/app/api/auth/` | 登录 API routes | supabase → druvia |
| `h5/src/app/api/stats/` (30+ files) | 统计 API routes | 全部改写 |
| `h5/src/services/storage/supabase-storage.ts` | Storage provider | 替换为 druvia.storage |
| `h5/.env` | 环境变量 | SUPABASE_* → DRUVIA_* |

### 8.3 RPC 函数迁移

20+ PG 函数从 Supabase 导出并导入 Druvia 项目 schema：

**核心业务：**
- `confirm_drafts` — 确认比赛草稿
- `create_draft_with_events` — 创建草稿+事件
- `update_draft_with_events` — 更新草稿+事件
- `detect_conflicts_optimized` — 冲突检测
- `get_drafts_optimized` — 获取草稿

**统计计算：**
- `calculate_season_aggregation` — 赛季统计
- `calculate_player_combo_aggregation` — 组合统计
- `get_team_color_standings` — 队伍排名

**数据管理：**
- `import_player_with_transaction` — 导入球员
- `verify_excel_totals` — Excel 校验
- `cleanup_season_data` — 赛季清理
- `batch_assign_tiers` — 批量分级
- `update_import_batch_stats` — 更新导入统计

迁移方式：
1. `pg_dump --schema-only` 导出函数定义
2. 调整 schema 引用（函数在同 schema 内可去掉 `public.` 前缀）
3. 导入 Druvia 项目 schema
4. SDK `druvia.rpc()` 通过 RPC 代理端点调用

### 8.4 API Routes 改写

30+ API routes 逐个改写，CRUD 部分改为 Druvia 原生 API，RPC 部分改为 `druvia.rpc()`。

### 8.5 验证标准

- [ ] username 登录 / session 管理正常
- [ ] 比赛数据 CRUD 正常
- [ ] 草稿确认 / 冲突检测等 RPC 正常
- [ ] 赛季统计计算正常
- [ ] 球员数据导入正常
- [ ] 图片上传 / 显示正常

---

## 九、阶段 4 — 验证与文档

### 9.1 端到端验证

```
验证环境：Docker Compose 本地开发环境
  - Druvia API + PostgreSQL + Hasura + Redis + Deno Worker
  - taro-app 小程序端（微信开发者工具）
  - taro-app H5 端（浏览器）

验证流程：
  1. 微信扫码登录 → 静默登录 → 注册新用户
  2. 创建活动 → 加入活动（RPC）→ 实时通知
  3. 上传头像/Logo → 显示正常
  4. H5 端 username 登录 → 比赛管理
  5. 创建草稿 → 冲突检测 → 确认草稿（RPC 链路）
  6. 赛季统计计算 → 排名展示
  7. 球员数据导入 → Excel 校验
  8. 维护模式开关 → 小程序端实时响应
```

### 9.2 文档交付

```
1. Supabase → Druvia 迁移指南
   更新 docs/migration/supabase-compat.md
   - 完整 API 映射表（基于 taro-app 实际验证）
   - supabase.rpc() 映射更正：从 "Hasura Actions 🚧" 改为 "RPC 代理端点 ✅"
   - 逐步迁移教程
   - 常见问题与解决方案

2. @druvia/sdk 使用文档
   - 快速开始
   - API 参考（auth / from / rpc / storage / realtime / functions）
   - 小程序环境配置
   - GraphQL 直写用法

3. RPC 函数迁移指南
   - 如何导出 Supabase PG 函数
   - 如何导入 Druvia 项目 schema
   - SDK rpc() 使用说明

4. Edge Functions 部署指南
   - Deno Worker 配置
   - 函数部署流程
   - 从 Supabase Edge Functions 迁移
```

---

## 十、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| SDK 链式 API 覆盖不全 | taro-app 用到的某些操作符未实现 | 先扫描 taro-app 所有调用模式，确保覆盖 |
| Realtime 语义差异 | Hasura subscription 推送当前状态而非变更事件 | SDK 维护本地快照 diff 检测变更类型（见 4.5） |
| PG 函数跨 schema 引用 | taro-app 的函数可能引用 public. 下的表 | 导入时统一替换 schema 引用 |
| Deno Worker 执行模型 | 当前不支持 Deno.serve() handler 模式 | 扩展 executor.ts 支持 handler 提取（见 6.2） |
| Edge Function 内 Supabase 特有 API | 函数内可能用了 Supabase admin API | 用 @druvia/sdk 的 service client 替代 |
| select('*') 字段发现 | Hasura 不支持 SELECT *，需要知道表的字段列表 | SDK 懒加载 introspection + 缓存（见 4.4） |
| 微信小程序 WebSocket | Hasura Realtime 用标准 WebSocket，小程序用 wx.connectSocket | SDK 支持 websocket 适配器注入（见 4.6） |
| Hasura 权限全开 | 当前权限 filter 为 `{}`，任何认证用户可读写所有数据 | 阶段 2/3 迁移时为 taro-app 表配置 Hasura 权限规则，至少按 user_id 限制 |
| 数据迁移序列未重置 | 导入数据后 INSERT 产生主键冲突 | 导入后执行 setval 重置所有序列（见 7.3） |

---

## 十一、未来扩展

### compat 兼容层（后续可选）

taro-app 迁移完成后，可基于原生 SDK 封装 `@druvia/sdk/compat`：

```typescript
import { createClient } from '@druvia/sdk/compat'

// 100% 对齐 Supabase SDK 接口
// 其他 Supabase 项目可 drop-in 替换 import 完成迁移
const client = createClient(url, apiKey)
await client.from('users').select('*').eq('id', 1)
await client.rpc('my_function', { arg: 1 })
```

compat 层是原生 API 的薄封装，确保方法签名和返回格式与 Supabase SDK 一致。优先级低于原生 SDK，在有实际迁移需求时再实现。

### 迁移 CLI 工具（后续可选）

```bash
druvia migrate from-supabase \
  --supabase-url=https://xxx.supabase.co \
  --supabase-key=xxx \
  --target-project=my-project

# 自动完成：
# 1. 导出 Supabase schema → Druvia 项目建表
# 2. 导出数据 → 导入
# 3. 生成 API 差异报告
```

---

*Last Updated: 2026-03-17*
