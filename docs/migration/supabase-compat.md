# Supabase → Druvia 迁移兼容性对照

## 功能对照表

| Supabase 功能 | Druvia 对应 | 状态 | 版本 | Issue |
|--------------|-------------|------|------|-------|
| **Auth** | | | | |
| supabase.auth.signUp() | POST /api/v1/auth/register | ✅ | v0.1.0 | |
| supabase.auth.signInWithPassword() | POST /api/v1/auth/login | ✅ | v0.1.0 | |
| supabase.auth.signInWithOAuth() | GET /api/v1/tenants/:tenantId/oauth/:provider/authorize | ✅ | v0.1.0 | |
| supabase.auth.signOut() | 前端清除 token（无服务端路由） | ⚠️ | v0.1.0 | |
| supabase.auth.getUser() | GET /api/v1/users/me | ✅ | v0.1.0 | |
| **Database** | | | | |
| supabase.from().select() | GraphQL query (Hasura) | ✅ | v0.1.0 | |
| supabase.from().insert() | GraphQL mutation | ✅ | v0.1.0 | |
| supabase.from().update() | GraphQL mutation | ✅ | v0.1.0 | |
| supabase.from().delete() | GraphQL mutation | ✅ | v0.1.0 | |
| supabase.rpc() | Druvia PostgreSQL RPC | ⚠️ | 待发布 | 形状可迁移，函数需自行鉴权 |
| Row Level Security | - | ❌ | - | |
| **Realtime** | | | | |
| supabase.channel().on().subscribe() | Hasura Subscriptions + Druvia token exchange | ✅ | 待发布 | PostgreSQL changes 子集 |
| Broadcast | - | ❌ | - | |
| Presence | - | ❌ | - | |
| **Storage** | | | | |
| supabase.storage.from().upload() | POST /api/v1/projects/:id/storage/buckets/:name/objects | ✅ | v0.1.0 | |
| supabase.storage.from().download() | GET /api/v1/projects/:id/storage/buckets/:name/objects/* | ✅ | v0.1.0 | |
| supabase.storage.from().getPublicUrl() | GET /api/v1/storage/public/:projectId/:bucketName/* | ✅ | v0.1.0 | |
| supabase.storage.from().createSignedUrl() | POST /api/v1/projects/:id/storage/buckets/:name/signed-url | ✅ | v0.1.0 | |
| Image transformations | - | ❌ | - | |
| **Edge Functions** | | | | |
| supabase.functions.invoke() | Druvia Edge Functions | ⚠️ | 待发布 | 调用形状可迁移，权限模型不同 |

## 状态说明

- ✅ 已完成 — 可直接使用
- 🚧 开发中 — 部分可用或计划中
- ❌ 待开发 — 尚未实现

## 迁移注意事项

1. Supabase 使用 REST API + PostgREST，Druvia 使用 GraphQL (Hasura)
2. 认证 JWT 格式不同，需要更新前端 token 处理逻辑
3. Storage API 路径不同，需要替换所有上传/下载调用
4. RLS 在 Druvia 中暂不支持，需要通过 Hasura 权限系统替代

### Project Data Access Batch 3A/3B/4

- 应用 GraphQL 端点是 `/api/v1/projects/:projectId/graphql`，不是 Hasura `/v1/graphql`。
- SDK `from()` / `graphql()` 只使用 Project Session 或项目 API Key；平台后台 session 不再赋予应用 GraphQL 权限。
- Project access token 与 API Key 同时存在时，以 Project access token 为准；token 无效或过期会返回 `401`，不会降级为匿名 API Key。
- 迁移 `018_project_data_access_mode` 将已有项目保留为 `compatibility`，因此旧 `user` role 行为不会因部署代码而自动切换。
- Batch 3A 后新建项目使用 `explicit` scoped role；表必须先配置对应的数据访问权限，否则查询会被 Hasura 权限拒绝。
- 已有项目可在应用迁移 `019_data_access_migrations` 后，通过 Admin 的数据访问预检、确认、验证和回滚流程切换到 `explicit`；不应手工直接修改数据库字段。
- Batch 4 仅自动识别 Druvia 历史生成的精确旧规则。能由表级预设表达的自定义 filter/preset/列权限可先改为受支持规则；重复规则、跨项目角色绑定以及 Action/Remote Schema/inherited role 等顶层 actor 绑定会持续阻断，不能通过本批次自动映射。无法移除时应保持 compatibility。
- 旧匿名写权限不会迁移到 scoped role；旧认证 select 的 aggregate 能力也会收紧。两类变化都需要独立风险确认和项目别名确认。
- Realtime 调用仍使用 `channel().on().subscribe()`；SDK 会在建立 Hasura socket 前异步调用 Druvia API 换取短期令牌，不需要应用直接处理 Hasura JWT。
- Druvia client 的 base URL 必须指向 API 根路径，例如 `https://host/api/v1`，令牌交换不会从 Hasura URL 推导管理 API。
- Realtime 提供 `connecting / connected / reconnecting / error / closed` 状态回调，并在令牌续期、网络断开或 Project Session 身份变化时自动重连和恢复订阅。
- 重连会重新取得当前订阅快照，但不会重放断线期间的事件；依赖无丢失事件流的应用仍需业务游标或补偿查询。
- 尚未执行 Batch 4 的 compatibility 项目继续使用全局 `user` / `anonymous` permissions，不应据此声明跨项目 scoped 隔离；完成迁移、验证并激活后才获得该保证。
- 已签发 token 的到期会阻止新连接并驱动 SDK 合作式续期，但当前不承诺恶意客户端的已建立 socket 在到期瞬间被强制关闭。

### Project Actor RPC / Functions cutover

- SDK 的 Database、RPC 和 Functions 都不再把 Platform Session 当作应用凭证。Project Session 存在时使用 project token；否则 RPC 无匿名能力，Functions 仅能通过项目 API Key 调用显式配置为 `anon_allowed` 的函数。
- 无效或过期 Project Session 不会自动降级为 API Key，应用必须刷新或重新建立 Project Session。
- Druvia RPC 会在调用事务中提供 `request.jwt.claims`、`request.headers` 和 `druvia.actor`。这只是可信调用者上下文，不等同于 Supabase PostgreSQL RLS；迁移的数据库函数仍必须读取 claims 并实现自身业务授权。
- `druvia.graphql()` 按项目 `data_access_mode` 和 Function actor 使用 Hasura permissions。Project User/API Key 只能看到其角色允许的数据，Platform User 的管理测试调用不能借此获得 admin 数据访问。
- 从 Supabase Edge Functions 迁移时，先为函数使用的表配置 Druvia Data Access 权限。依赖 service role 绕过 RLS 的函数不能原样迁移，应拆分为受控 trusted backend 能力或显式服务身份设计。
- 直接 SDK Storage 已使用 Project Session/API Key application identity，不再使用 Platform Session。受保护对象路由要求 Project User；仅 API Key 调用会返回 `PROJECT_ACTOR_REQUIRED`，因此匿名文件必须使用 public URL 或显式 trusted capability。
- bucket 的项目用户访问必须从 `admin_only / owner_only / authenticated_read` 中选择，公开下载由独立 `public` 开关控制。迁移 `020` 将旧 bucket 保守设为 `admin_only`，上线后需逐 bucket 显式开放。
- SDK upload/download 的二进制实现当前只保证标准浏览器/Node；Taro/微信小程序应继续通过 Edge Function 与 `druvia.storage` runtime helper 或项目自有 native adapter 迁移。
- 自定义 fetch 环境可使用 Auth、查询、RPC、Functions、Storage list/remove/signed URL 等 JSON-only 方法，即使没有全局 `FormData`；这不代表该环境已支持 Storage 二进制上传或 `Response.blob()` 下载。
