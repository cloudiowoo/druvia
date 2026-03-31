# Druvia SDK 通用能力状态与接入路线对比

## 背景

2026-03 下旬以来，Druvia 围绕 taro-app / H5 迁移，连续补齐了多项 SDK 与 API 能力：

- 项目级 `projectAuth`
- trusted session issuer
- trusted storage ticket
- QueryBuilder 的 `.or()` / `.not()` / `.maybeSingle()`
- GraphQL mutation `returning` 构建修正
- RPC `json/jsonb` 与 `RETURNS TABLE / OUT` 兼容
- `select('*')` 的 introspection 与数组字段兼容

这些更新已经让 SDK 不再只是“最低可跑”的迁移壳层，而是进入了“具备通用接入能力，但仍有兼容边界”的阶段。

本文件用于沉淀当前阶段对 SDK 的统一判断，便于后续做：

- 新应用接入路线比较
- taro-app / H5 迁移路线比较
- SDK 演进优先级排序
- breaking change 风险识别

## 目标

给出一份可长期复用的、面向路线决策的 SDK 状态评估，而不是一次性的调试结论。

本文件回答四类问题：

1. SDK 当前哪些能力已经具备通用可用性
2. 哪些能力仍然只是“迁移主线可用”，还不适合对外宣称完整稳定
3. 现阶段不同应用类型应优先走哪条接入路线
4. 最近更新里哪些点可能对已有应用形成回归风险

## 范围

本次评估覆盖以下 SDK 模块：

- `auth`
- `projectAuth`
- `database / QueryBuilder`
- `rpc`
- `functions`
- `storage`
- `realtime`
- `client` 级 token / adapter 注入策略

不包含：

- MCP SDK
- Edge Function runtime helper 的完整能力面
- 后端 provider adapter 的全量可用性比较
- Admin UI 的交互细节

## 总体判断

当前可以将 Druvia SDK 的实现状态概括为：

### 1. 模块骨架已完整

SDK 已具备以下正式模块：

- `auth`
- `projectAuth`
- `database`
- `rpc`
- `functions`
- `storage`
- `realtime`

同时支持多宿主注入：

- `fetch`
- `storage`
- `websocket`

这意味着 SDK 在结构上已经具备浏览器、Node、Taro / 小程序等多环境复用基础，而不是绑定单一前端运行时。

### 2. 通用能力已进入真实可用阶段

从“新项目主线路线”角度看，以下能力已具备较强通用性：

- 项目级终端用户登录与 session 管理
- 受信后端签发 trusted session
- 受信后端签发 storage ticket
- 基础 CRUD / QueryBuilder
- 登录后 `rpc` / `functions` 调用

### 3. 仍未达到“无条件 Supabase drop-in”

当前 SDK 不应被表述为“对 Supabase SDK 100% 对齐”。

主要原因：

- `database/graphql` 仍不自动走 `project_user` token
- storage 的正式主线已分成基础 bucket API 与 trusted ticket 两层
- mutation 默认返回结构近期已变化
- project session storage key 已按项目隔离，但旧 key 兼容未完全收口
- Realtime 仍是 Hasura subscription 语义桥接，不等于 Supabase Realtime 全量能力

因此更准确的定位是：

- “通用能力已形成”
- “迁移主线已基本跑通”
- “兼容层与升级平滑性仍需继续补”

## 能力矩阵

| 模块 | 当前状态 | 通用性判断 | 当前主要用途 | 备注 |
|------|----------|------------|--------------|------|
| `auth` | 已实现 | 中高 | 平台后台 / 管理用户 | 比较稳定，但不适用于项目终端用户主线 |
| `projectAuth` | 已实现 | 高 | 小程序/H5 终端用户 session | 当前最接近正式通用能力 |
| `database / QueryBuilder` | 已实现 | 中高 | CRUD / GraphQL query builder | 功能覆盖已明显增强，但兼容风险仍在 mutation 默认返回 |
| `rpc` | 已实现 | 高 | 项目业务 RPC | API 侧已补齐 `json/jsonb` 与 `RETURNS TABLE` 兼容 |
| `functions` | 已实现 | 中高 | Deno Worker invoke | `project_user` 优先，适合登录后函数调用 |
| `storage` 基础 bucket API | 已实现 | 中 | 平台后台 / 基础对象操作 | 不等于“终端用户上传正式主线” |
| `storage` trusted helper | 已实现 | 高 | H5/BFF 受控上传删除 | 已形成正式新主线 |
| `realtime` | 已实现 | 中 | Hasura subscription 包装 | 适合主线使用，但不是全量 Supabase 兼容 |
| `client` token 注入 | 已实现 | 中 | 平台 token / 项目 token 分流 | 仍存在旧 session key 兼容收口问题 |

## 模块状态细分

## 1. `auth`

### 已具备

- `signUp`
- `signIn`
- `signOut`
- `getUser`
- `getSession`
- `getToken`
- `updateUser`
- `refreshSession`

### 当前定位

更适合：

- 平台后台
- tenant / owner / admin 场景
- 非项目终端用户链路

### 结论

`auth` 是稳定基础模块，但它不是当前 taro-app / H5 迁移主线。

## 2. `projectAuth`

### 已具备

- `wechatLogin()`
- `wechatSilentLogin()`
- `signInWithProvider()`
- `silentLoginWithProvider()`
- `refreshSession()`
- `logout()`
- `getSession()`
- `getUser()`
- `getToken()`
- `issueTrustedSession()`

### 当前定位

这是当前 SDK 中最接近“正式终端用户认证层”的模块。

它已经完成了两件关键事情：

1. 把 `projectAuth` 与平台 `auth` 分离
2. 把 trusted session issuer 接入正式 session 生命周期

### 当前边界

- trusted-issued session 目前没有独立 TTL，而是复用项目级 auth config
- provider 路由已通用化，但后端 adapter 真正现成可用的仍主要是 `wechat`，`oidc` 已进入复用主线

### 结论

对新项目、H5、taro-app 而言，`projectAuth` 已经是正式主线，不应再回退到 Edge Function 自造 JWT。

## 3. `database / QueryBuilder`

### 已具备

- `select / insert / update / delete / upsert`
- `eq / neq / in / gt / gte / lt / lte / like / ilike / is`
- `order / range / limit`
- `single / maybeSingle`
- `.or()`
- `.not()`
- `select('*')` introspection 展开
- mutation `returning { ... }` 包装
- 嵌套 JSON / Date 序列化
- `select('*')` 对数组标量字段兼容

### 当前价值

从 taro-app / H5 的真实使用情况看，当前 QueryBuilder 已能覆盖大部分基础 CRUD。

最近最关键的两个修复是：

1. mutation 显式 `.select()` 时正确生成 Hasura `returning`
2. `select('*')` 不再错误丢失数组字段，例如 `text[] / uuid[]`

### 当前边界

当前最需要谨慎的不是“功能缺没缺”，而是“默认返回语义是否稳定”。

最近 mutation 默认返回已改为：

- 未显式 `.select()` 时返回 `{ affected_rows }`

这对新调用很清晰，但对旧调用并不一定兼容。

### 结论

QueryBuilder 的功能面已经进入“通用可用”，但它仍然是当前 SDK 最需要警惕 breaking change 的模块之一。

## 4. `rpc`

### 已具备

- `druvia.rpc(name, args)`
- 项目级 token 注入
- API 侧命名参数映射

### 当前价值

API 侧近期已补齐两个关键兼容点：

1. `json/jsonb` 入参序列化与显式 cast
2. `RETURNS TABLE / OUT` 的签名解析过滤

这让真实业务函数，例如：

- `batch_insert_score_events`
- `calculate_all_season_aggregations`

不再因为签名解析而被错误调用。

### 结论

`rpc` 已经是当前最适合作为项目业务主线的 SDK 能力之一。

## 5. `functions`

### 已具备

- `functions.invoke(name, { body, headers })`
- 客户端项目级调用包装
- token 选择顺序与 `project_user` 协同

### 当前价值

对登录后函数调用场景，`functions` 已进入正式可用。

尤其是在 projectAuth 落地后：

- `project_user` 已能访问 `jwt_required` 的 function invoke
- trusted-issued session 也能复用这条路径

### 当前边界

- 匿名调用仍是函数级显式开放，不应视为默认能力
- 登录前函数和登录后函数必须继续分开治理

### 结论

`functions` 已可作为项目主线能力，但仍依赖后端权限模型保持清晰，不属于“随便开匿名都安全”的模块。

## 6. `storage`

当前应明确分成两层看待。

### 6.1 基础 bucket API

已具备：

- `upload`
- `list`
- `remove`
- `download`
- `getPublicUrl`
- `createSignedUrl`

它适合：

- 平台后台
- 平台用户直调
- 基础存储管理场景

但它不应再被直接等同为“终端用户上传正式主线”。

### 6.2 trusted storage helper

已具备：

- `issueUploadTicket()`
- `issueRemoveTicket()`
- `uploadWithTicket()`
- `removeWithTicket()`

它适合：

- H5 server / BFF
- 服务端控权上传
- 终端用户头像、队伍头像等受限上传/替换

### 结论

`storage` 目前不是“一条通路”，而是“基础 API + trusted ticket”双层模型。

对外部应用而言，trusted ticket 已经是正式推荐路径。

## 7. `realtime`

### 已具备

- channel 创建
- `on('postgres_changes', ...)`
- `subscribe()`
- `removeChannel()`
- 自定义 websocket factory

### 当前价值

它已经能满足：

- Taro / 小程序适配
- Hasura subscription 包装
- 本地快照 diff 后输出 `INSERT/UPDATE/DELETE` 语义

### 当前边界

它仍不是完整 Supabase Realtime：

- 没有 Broadcast
- 没有 Presence
- 本质上仍然依赖 Hasura subscription + 客户端 diff

### 结论

`realtime` 已可用于主线业务，但不应对外描述成 Supabase Realtime 全量等价。

## 路线对比

## 路线 A：平台后台 / 平台用户路线

适用：

- Admin
- tenant owner
- 项目管理后台

推荐组合：

- `auth`
- `database/graphql`
- 基础 `storage`

优点：

- 现有能力成熟
- 与平台后台模型一致

限制：

- 不适合作为项目终端用户主线

## 路线 B：小程序 / 项目终端用户路线

适用：

- taro-app
- H5 终端用户主业务链路

推荐组合：

- `projectAuth`
- `rpc`
- `functions`

阶段性限制：

- `database/graphql` 仍未正式切到 project-user 直连主线
- storage 终端上传不建议直接走基础 `upload()`

## 路线 C：受信后端 / BFF 路线

适用：

- H5 server
- SSR / BFF
- 内部 worker

推荐组合：

- `projectAuth.issueTrustedSession()`
- `storage.issueUploadTicket()`
- `storage.issueRemoveTicket()`
- `storage.uploadWithTicket()`
- `storage.removeWithTicket()`

优点：

- 不要求浏览器直持 trusted backend key
- 能把身份和上传能力拆开治理

### 当前判断

这是 H5 / 外部应用目前最正式、最清晰的接入主线。

## 路线 D：Supabase 风格“无差别直接平迁”路线

当前不建议再把它作为默认路线。

原因：

- 当前 SDK 不是完全 Supabase drop-in
- mutation 默认返回结构已出现偏移
- project session / storage / realtime 都已进入 Druvia 自身模型，不再适合硬套 Supabase 心智

结论：

应以“Druvia 原生主线 + 有选择地兼容 Supabase 用法”作为后续路线，而不是继续追求表面 1:1 复刻。

## 兼容风险清单

## 1. mutation 默认返回值变化

当前 `.insert() / .update() / .delete() / .upsert()` 在未显式 `.select()` 时，默认返回：

```ts
{ affected_rows: number }
```

而不是旧式行数组。

风险：

- 旧应用若直接读取 `result.data[0]`
- 旧应用若默认假设存在 `id`
- 旧应用若以“返回行数组长度”判断成功

都可能出现运行时回归。

这是当前最明确的 SDK 兼容风险之一。

## 2. project session 存储 key 已按项目隔离

当前 project session key 为：

```text
druvia.project_session:${projectId}
```

这是正确方向，但若旧应用仍使用旧 key，升级后首次加载可能读不到旧 session。

影响：

- `rpc`
- `functions`
- 依赖项目 session 的前端登录状态恢复

当前应视为“升级平滑性尚未完全收口”。

## 3. `database/graphql` 与 `project_user` 仍未完全合流

当前 token 注入策略仍是：

- `database/graphql`：平台 token 路径
- `rpc/functions`：项目 token 优先

这意味着：

- project-user session 已是正式主线
- 但 `from()/graphql()` 还不能直接被表述为同等级 project-user 正式主线

## 4. 文档叙述存在滞后风险

近期 SDK 行为已多次演进，但旧文档中仍有：

- “相同调用”
- “兼容 Supabase”
- “直接可平迁”

这类容易被过度解读的描述。

后续如果继续对外输出 SDK 能力，需要以本文件为参考做收口。

## 当前推荐

## 对新应用

推荐采用 Druvia 原生主线：

- 项目终端用户：`projectAuth`
- 业务读写：优先 `rpc / functions`
- 受控上传：`trusted storage ticket`

不建议从一开始就按 Supabase drop-in 心智设计。

## 对 taro-app

当前主线仍然是：

- `projectAuth`
- `rpc`
- `functions`
- Edge Function / internal storage helper

若后续继续减少 Edge Function 参与度，可逐步评估：

- project-user GraphQL
- 更原生的 storage 直连能力

## 对 H5 / 外部应用

当前最推荐主线是：

- `projectAuth.issueTrustedSession()`
- `storage ticket`

这是目前最清晰、最安全、最能依附 Druvia 正式能力的路线。

## 后续路线评估基准

后续再讨论 SDK 路线时，建议统一按以下四个维度比较：

1. 是否属于正式主线，而不是迁移期兼容技巧
2. 是否已具备跨项目 / 跨应用复用价值
3. 是否会对已有应用造成 breaking change
4. 是否已经有足够测试与文档支撑对外承诺

## 下一阶段建议

### P0

- 补齐 project session 旧 key fallback / 迁移
- 明确 mutation 默认返回值是否保留现状，还是恢复旧行为
- 同步修正文档中“Supabase 兼容 / 相同调用”的过宽表述

### P1

- 推进 `database/graphql` 的 project-user 正式主线设计
- 为新应用形成一版对外能力矩阵

### P2

- 再评估是否需要 `compat` 层
- 再评估 Realtime 更深层的 Supabase 兼容价值

## 一句话结论

截至 2026-03-31，Druvia SDK 已具备真实通用能力，但当前更适合被定义为：

> “以 Druvia 原生接入路线为主的多模块 SDK，迁移主线已基本成型，但仍需继续收口升级兼容与能力边界。”
