# Druvia Project Memory

Codex 项目记忆，记录当前阶段新会话最值得优先恢复的事实。

## 产品与叙事

- 当前产品默认按“单租户 + 多项目”理解。
- Druvia 面向中文开发者，目标体验接近 Supabase，但底层以 Hasura 为核心。
- 真实需求牵引以 taro-app / Supabase 迁移兼容为主，而不是抽象平台能力先行。

## 当前优先级

- SDK 补齐与 Supabase 迁移兼容
- 权限模型细化，尤其是 API key、Functions、Realtime
- 项目终端用户 Auth Phase 1 已开始落地，优先解 taro-app 登录后受保护接口链路
- 商业化前置能力仍在规划，但不是当前一线开发焦点

## Project User Auth Phase 1

- API 已新增项目级认证路由：
  - `POST /api/v1/projects/:projectId/auth/wechat/login`
  - `POST /api/v1/projects/:projectId/auth/wechat/silent-login`
  - `POST /api/v1/projects/:projectId/auth/:provider/login`
  - `POST /api/v1/projects/:projectId/auth/:provider/silent-login`
  - `POST /api/v1/projects/:projectId/auth/refresh`
  - `POST /api/v1/projects/:projectId/auth/logout`
- 请求身份已显式拆分为三类：
  - `platform_user`
  - `project_user`
  - `apikey`
- `PROJECT_AUTH_JWT_SECRET` 可独立于平台 `JWT_SECRET`。
- `authenticate()` 需要识别 project-user token，而不能只按平台 secret 验 Bearer token。
- 项目级 refresh token 基础设施依赖：
  - `migrations/016_project_user_auth_phase1.up.sql`
- taro-app 当前联调库仍需兼容旧字段：
  - `wx_open_id` 仍是有效查找键
  - `provider_id` / `last_login_at` 不能假设已存在
- `project-auth` 在 signup 分支不能假设 `<schema>.users.id` 是文本主键：
  - 若 `users.id` 为 `uuid`，服务端必须写入合法 UUID，不能写入 `user_xxx`
  - 若项目仍是文本型 `users.id`，才继续兼容字符串主键模式
- `project-auth` 不能假设 UUID 主键一定带数据库默认值：
  - 对 UUID 主键用户表，当前由 API 在创建时显式生成 UUID
  - 建用户底层约束错误需包装为语义化 auth 错误，如 `USER_CREATE_FAILED`
- `project-auth` 的正式演进方向已确定为：
  - 通用 provider 核心
  - provider adapter 负责 `exchangeCode()`
  - 微信路由只是兼容别名，不应成为每个 provider 都复制一套 controller/service 的模板
- 当前通用核心已支持按 provider 复用同一套：
  - 项目配置读取
  - 用户查找/创建
  - session / refresh token 签发
- 但真正可用的 provider 仍取决于现有 adapter 实现状态；当前已落地的是 `wechat`，`oidc` 路径已可复用 generic core。
- Phase 1 里：
  - `Functions jwt_required` 已接受同项目 `project_user`
  - `RPC` 已接受同项目 `project_user`
  - GraphQL project-user 能力仍不在本阶段内

## SDK Project Auth 近期事实

- SDK 已新增 `client.projectAuth`，与平台 `client.auth` 分离。
- 项目侧 session 存储键为：
  - `druvia.project_session:${projectId}`
- `functions` / `rpc` 的 token 选择顺序现在是：
  1. project session token
  2. platform session token
- `database/graphql` 与 `storage` 仍保持平台 token 路径，不自动切到 project token。
- 新迁入应用应优先调用平台 project auth API，而不是继续依赖 Edge Function 自造 session。

## GraphQL 限流配置近期事实

- GraphQL 代理限流现已支持项目级配置，管理入口为：
  - `/t/:tenantId/p/:projectId/settings/rate-limits`
- 配置存储在：
  - `project.settings.rateLimits.graphql`
- 当前字段语义为：
  - `perUser`: 每项目内单 actor 每分钟限额
  - `perProject`: 项目总计每分钟限额，`0` 表示不限
- 当前 actor 归并规则为：
  - `platform_user` -> `platform:${userId}`
  - `project_user` -> `project:${sub}`
  - `apikey` -> `anon-ip:${request.ip}`
- 因此当前匿名 `apikey` 流量仍按来源 IP 聚合，不是按 API key id 独立计数。
- GraphQL 限流 Redis key 必须包含 `projectId`，否则会把跨项目流量错误合并。
- 项目设置保存虽已改为 `settings` 顶层 JSONB merge，但 `rateLimits` 内部仍不是深合并：
  - 前端保存 `rateLimits.graphql` 时必须保留同级其他子键
  - 不能只提交一个孤立的 `graphql` 子对象并假设后端会自动深合并

## Functions / API Key 近期事实

- API 已支持 `apikey` fallback 认证。
- GraphQL 代理已适配匿名 `apikey` 链路。
- Functions invoke 权限不再是“同项目匿名 apikey 可调用任意函数”。
- 当前采用函数级 `invoke_auth_mode`：
  - `jwt_required`
  - `anon_allowed`
- 默认值必须是 `jwt_required`。
- Edge Function 平台侧已开始补正式内部数据通道：
  - API 提供 internal GraphQL proxy
  - 运行时内建 `druvia.graphql()`
  - 平台级 Hasura secret 不应再作为项目函数的正式 secrets 方案

## Functions 匿名调用规则

- 只有明确属于登录前流程的函数，才应考虑 `anon_allowed`。
- 当前应优先视为匿名开放候选的函数：
  - `wx-silent-login`
  - `wx-login-register`
  - `wx-auth`
  - `wx-auth-fixed`
- 上传类、用户态、后台函数默认不应开放匿名调用，例如：
  - `upload-avatar`
  - `upload-team-logo`

## Edge Function 内部调用规则

- 新函数应优先使用运行时内建 `druvia.graphql()`，而不是项目 secrets 中的 Hasura admin 类凭证。
- internal token 属于执行期内部凭证，不属于 Admin secrets UI 中的项目配置项。
- `DRUVIA_GRAPHQL_URL`、`HASURA_ADMIN_SECRET`、等价的 `DRUVIA_SERVICE_ROLE_KEY` 不应继续作为正式推荐的函数数据访问模型。
- 终端用户图片上传的 Phase 1 正式模型已确定为：
  - API internal storage proxy
  - 运行时内建 `druvia.storage.upload()` / `druvia.storage.remove()`
  - 平台级 storage 写权限只保留在 API 服务端
- `DRUVIA_TOKEN` 不再是项目函数写 storage 的正式方案，只可视为历史临时兼容思路。
- `druvia.storage.upload()` 当前是窄能力：
  - 当前支持 `upload()` 与受控 `remove()`
  - helper 对函数作者不暴露 `projectId` / `caller`
  - helper 原始返回 `{ path, publicUrl, object }`
  - `publicUrl` 仅在目标 bucket 为 public 时非 `null`
- `remove({ bucket, path, ignoreMissing? })` 已可用于头像/队徽替换场景里的旧对象清理。
- internal storage route 会把以下审计字段写入 `druvia_storage_objects.metadata`：
  - `created_by_type`
  - `created_by_platform_user_id`
  - `created_by_project_user_id`
  - `source_function`
- 同路径重传时，storage metadata 中的上述审计字段也必须刷新，不能沿用旧调用者信息。

## 管理端与迁移注意事项

- Admin 端 Functions 页面已经增加 `invokeAuthMode` 的展示与编辑能力。
- 创建函数时不暴露该字段，默认保持 `JWT Required`。
- Admin 端 Tables 页面现在要区分两类 Hasura 操作：
  - `同步 GraphQL 权限` = track tables / relationships / permissions
  - `刷新 Hasura Schema` = 触发 Hasura metadata reload，处理字段缓存未刷新问题
- 在 Admin Tables 页面内执行：
  - `addColumn`
  - `dropColumn`
  - `renameColumn`
  这三类列级 DDL 后，API 会自动执行一次 Hasura metadata reload。
- 如果变更来自：
  - 外部 SQL
  - 手工 migration
  - 数据库页直接执行的 schema 变更
  则不能假设 Hasura cache 已自动刷新；此时应显式点击 `刷新 Hasura Schema`。
- Admin 端项目级 Auth 页面
  - `/t/:tenantId/p/:projectId/auth`
  - 当前就是微信小程序 `project-auth` 的配置入口
  - UI 中的 `Client ID` / `Client Secret` 应按 `微信 AppID` / `微信 AppSecret` 理解
  - 当前微信登录类型固定按 `miniprogram` 处理，不应再依赖旧的 Edge Function secrets 约定
- Admin 端数据库页要区分两条 SQL 链路：
  - DDL 模式仍会禁止 `CREATE FUNCTION` / `SECURITY DEFINER`
  - `/sql/import` 已支持导入带 `$$` 或 `$tag$` body 的 PL/pgSQL function SQL
- 在 Admin 中保存 `invokeAuthMode` 之前，数据库必须已执行：
  - `migrations/015_function_invoke_auth_mode.up.sql`
- 如果保存时报：
  - `column "invoke_auth_mode" of relation "druvia_functions" does not exist`
  说明迁移未执行，不是前端字段绑定问题。

## 文档优先级

当文档与代码不一致时，优先级应为：

1. 当前代码
2. 最近实施文档
3. 本目录下的 `design-decisions.md`
4. `.claude/memory/design-decisions.md`

## 建议回填时机

以下情况发生后，应优先更新本文件：

- 权限模型变化
- taro-app / Supabase 兼容结论变化
- 某个高频故障定位到明确前置条件
- 新会话最容易重复踩坑的事项出现
