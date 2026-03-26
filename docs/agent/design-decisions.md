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
- `project-auth` 创建项目业务用户时必须尊重 `<project schema>.users.id` 的真实类型：
  - 不能把平台风格 `user_xxx` 字符串强写进 UUID 主键业务表
  - UUID 主键项目由 API 显式生成合法 UUID，不依赖业务表一定存在默认值
- `project-auth` 暴露给客户端的失败语义应是 auth 级错误，而不是原始数据库约束错误直出。
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
- 项目级 Edge Function 的 storage 写入也遵循同一原则：
  - 正式模型是 API internal storage proxy
  - 运行时 helper 目前包含 `druvia.storage.upload()` 与受控 `druvia.storage.remove()`
  - 不向项目函数下发 `DRUVIA_TOKEN`、管理 JWT、或其他平台级 storage 写入凭证
- storage 上传审计先落在 `druvia_storage_objects.metadata` JSONB，而不是立即扩表加独立列。
- helper 可在运行时内部附带可信 `callerContext`，但这不是函数作者可自定义的公开 helper 参数。

## Hasura 同步策略

- `track-all` 与 `reload metadata` 是两类不同操作，不能混用概念：
  - `track-all` 负责表、关系、权限等 metadata 对象同步
  - `reload metadata` 负责刷新 Hasura schema / cache 视图
- Druvia 管理端对列级 DDL 的正式策略是：
  - Admin Tables 页面内的 `add/drop/rename column` 自动触发 `reload metadata`
  - 外部 SQL / migration 导致的 schema 漂移，由用户显式触发 `刷新 Hasura Schema`

## 文档策略

- `AGENTS.md` 用于入口与索引。
- `docs/agent/project-memory.md` 用于近期高价值事实。
- `docs/plans/*` 用于完整背景与实施过程。
- `.claude/*` 保留用于兼容，不作为 Codex 唯一事实来源。
