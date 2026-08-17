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
| supabase.rpc() | Hasura Actions | 🚧 | - | |
| Row Level Security | - | ❌ | - | |
| **Realtime** | | | | |
| supabase.channel().on() | Hasura Subscriptions | 🚧 | - | |
| Broadcast | - | ❌ | - | |
| Presence | - | ❌ | - | |
| **Storage** | | | | |
| supabase.storage.from().upload() | POST /api/v1/projects/:id/storage/buckets/:name/objects | ✅ | v0.1.0 | |
| supabase.storage.from().download() | GET /api/v1/projects/:id/storage/buckets/:name/objects/* | ✅ | v0.1.0 | |
| supabase.storage.from().getPublicUrl() | GET /api/v1/storage/public/:projectId/:bucketName/* | ✅ | v0.1.0 | |
| supabase.storage.from().createSignedUrl() | POST /api/v1/projects/:id/storage/buckets/:name/signed-url | ✅ | v0.1.0 | |
| Image transformations | - | ❌ | - | |
| **Edge Functions** | | | | |
| supabase.functions.invoke() | - | 🚧 | - | |

## 状态说明

- ✅ 已完成 — 可直接使用
- 🚧 开发中 — 部分可用或计划中
- ❌ 待开发 — 尚未实现

## 迁移注意事项

1. Supabase 使用 REST API + PostgREST，Druvia 使用 GraphQL (Hasura)
2. 认证 JWT 格式不同，需要更新前端 token 处理逻辑
3. Storage API 路径不同，需要替换所有上传/下载调用
4. RLS 在 Druvia 中暂不支持，需要通过 Hasura 权限系统替代

### Project Data Access Batch 3A

- 应用 GraphQL 端点是 `/api/v1/projects/:projectId/graphql`，不是 Hasura `/v1/graphql`。
- SDK `from()` / `graphql()` 只使用 Project Session 或项目 API Key；平台后台 session 不再赋予应用 GraphQL 权限。
- Project access token 与 API Key 同时存在时，以 Project access token 为准；token 无效或过期会返回 `401`，不会降级为匿名 API Key。
- 迁移 `018_project_data_access_mode` 将已有项目保留为 `compatibility`，因此旧 `user` role 行为不会因部署代码而自动切换。
- Batch 3A 后新建项目使用 `explicit` scoped role；表必须先配置对应的数据访问权限，否则查询会被 Hasura 权限拒绝。
- 已有项目切换到 `explicit` 仍需等待 Batch 4 的权限清单、备份、dry-run、验证与回滚流程，不应手工直接修改数据库字段。
- Realtime 尚未完成同等 actor 切换；Batch 3B 将使用短期令牌交换，不能把当前 HTTP 支持等同于 WebSocket 已兼容。
