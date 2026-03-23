# Druvia Codex Design Decisions

面向 Codex 的长期设计决策摘要。保留 `.claude/memory/design-decisions.md`，这里记录当前仍应优先相信的结论。

## 产品定位

- 当前主叙事是“单租户 + 多项目”。
- 多租户能力保留在架构与数据模型中，但不是当前默认产品表达。

## 数据与权限

- 核心元数据在 `public` schema。
- 业务数据隔离当前更接近 Schema-per-Project。
- 权限主要依赖 Hasura permissions，而不是 PostgreSQL RLS。

## 迁移兼容策略

- 涉及 Auth、GraphQL 代理、SDK 返回结构、Functions invoke 时，优先考虑 Supabase/taro-app 兼容需求。
- 不以“接口形状相似”判断兼容完成，必须结合真实迁移路径验证。

## 项目终端用户认证策略

- 平台用户认证与项目终端用户认证必须分层，不能继续共用一套 session 签发语义。
- 项目终端用户 access token / refresh token 由 Druvia API 正式签发，不再由 Edge Function 自造。
- Phase 1 复用 `<project schema>.users`，但必须兼容 taro-app 现存 `wx_open_id` 数据形态。
- `PROJECT_AUTH_JWT_SECRET` 可以独立配置；中间件必须同时支持 platform-user 与 project-user token 验签。
- SDK 侧 `projectAuth` 与 `auth` 分开存储，避免平台后台登录与项目业务登录污染同一 session 槽。
- provider 扩展策略采用“通用 auth 核心 + provider adapter”：
  - 不为每个 provider 重写整套 project-auth 模块
  - 共享用户查找/创建、refresh、logout、session 签发
  - 仅在 adapter / provider config 映射层处理差异

## Functions 权限策略

- 匿名 `apikey` 能力存在，但必须按模块和场景精细化控制。
- GraphQL 匿名访问是已允许模式。
- Functions invoke 必须默认 `jwt_required`。
- 只有显式配置为 `anon_allowed` 的函数，才允许同项目匿名 `apikey` 调用。
- 对匿名开放的函数应限定在登录前场景，不得扩散为上传类或用户态函数的默认策略。
- `jwt_required` 的正式含义已扩展为：
  - 允许 platform user
  - 允许同项目 project user
  - 拒绝 anonymous apikey
- Function Worker caller 上下文不再使用模糊的 `jwt/apikey` 二值模型，应显式区分：
  - `platform_user`
  - `project_user`
  - `apikey`

## Edge Function 数据访问策略

- 平台级 Hasura secret 只留在平台服务端。
- 项目级 Edge Function 的正式数据访问模型应走 API internal proxy，而不是直连 Hasura admin 通道。
- 运行时 helper 可以向函数暴露受控能力，如 `druvia.graphql()`；但 internal token 不应作为项目 secret 暴露给用户。

## 文档策略

- `AGENTS.md` 用于入口与索引。
- `docs/agent/project-memory.md` 用于近期高价值事实。
- `docs/plans/*` 用于完整背景与实施过程。
- `.claude/*` 保留用于兼容，不作为 Codex 唯一事实来源。
