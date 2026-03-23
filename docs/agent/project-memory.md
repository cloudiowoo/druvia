# Druvia Project Memory

Codex 项目记忆，记录当前阶段新会话最值得优先恢复的事实。

## 产品与叙事

- 当前产品默认按“单租户 + 多项目”理解。
- Druvia 面向中文开发者，目标体验接近 Supabase，但底层以 Hasura 为核心。
- 真实需求牵引以 taro-app / Supabase 迁移兼容为主，而不是抽象平台能力先行。

## 当前优先级

- SDK 补齐与 Supabase 迁移兼容
- 权限模型细化，尤其是 API key、Functions、Realtime
- 商业化前置能力仍在规划，但不是当前一线开发焦点

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

## 管理端与迁移注意事项

- Admin 端 Functions 页面已经增加 `invokeAuthMode` 的展示与编辑能力。
- 创建函数时不暴露该字段，默认保持 `JWT Required`。
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
