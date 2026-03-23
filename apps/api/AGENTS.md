# API Agent Notes

适用于 `apps/api` 目录及其子树。

## 模块职责

- Fastify 管理 API
- 认证、中间件、Functions、RPC、项目管理
- 对 Hasura、数据库迁移、Deno Worker 的管理层编排

## 当前高优先级

- 保持 Supabase / taro-app 迁移兼容
- 细化 `apikey`、Functions、GraphQL 代理权限模型
- 修改认证或项目访问校验时，优先检查匿名 `apikey` 与 JWT 的分支差异

## 工作规则

- 管理类路由默认保持 JWT-only。
- 匿名 `apikey` 能力必须是显式允许，不要扩散成默认放开。
- 涉及 Functions invoke 时，优先检查：
  - `functions.controller.ts`
  - `functions.service.ts`
  - `docker/deno-worker/*`
- 如新增需要匿名开放的函数能力，先确认 Worker 本身是否具备调用者身份校验。

## 近期风险

- `invoke_auth_mode` 依赖数据库迁移；代码先行、数据库未升级时，管理端会报保存失败。
- 上传类函数若未做调用者鉴权，不应依赖平台层匿名放行。

## 参考入口

- `docs/agent/project-memory.md`
- `docs/agent/design-decisions.md`
- `docs/plans/2026-03-19-apikey-auth-design.md`
- `docs/plans/2026-03-23-function-invoke-auth-ui-design.md`
