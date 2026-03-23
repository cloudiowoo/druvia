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

## Functions 权限策略

- 匿名 `apikey` 能力存在，但必须按模块和场景精细化控制。
- GraphQL 匿名访问是已允许模式。
- Functions invoke 必须默认 `jwt_required`。
- 只有显式配置为 `anon_allowed` 的函数，才允许同项目匿名 `apikey` 调用。
- 对匿名开放的函数应限定在登录前场景，不得扩散为上传类或用户态函数的默认策略。

## Edge Function 数据访问策略

- 平台级 Hasura secret 只留在平台服务端。
- 项目级 Edge Function 的正式数据访问模型应走 API internal proxy，而不是直连 Hasura admin 通道。
- 运行时 helper 可以向函数暴露受控能力，如 `druvia.graphql()`；但 internal token 不应作为项目 secret 暴露给用户。

## 文档策略

- `AGENTS.md` 用于入口与索引。
- `docs/agent/project-memory.md` 用于近期高价值事实。
- `docs/plans/*` 用于完整背景与实施过程。
- `.claude/*` 保留用于兼容，不作为 Codex 唯一事实来源。
