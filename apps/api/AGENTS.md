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
- 收紧自动生成的 Hasura permissions；当前存在过宽的 `user` CRUD 与匿名写权限，不能视为生产安全基线
- 统一 project-user 在 GraphQL、Realtime、Storage、Functions 和 RPC 中的身份语义

## 工作规则

- 管理类路由默认保持 JWT-only。
- 匿名 `apikey` 能力必须是显式允许，不要扩散成默认放开。
- 新建或同步 Hasura permissions 时，禁止默认生成无行过滤的写权限；任何匿名写入都必须有明确业务理由和测试。
- 修改认证请求头时，要联动检查 SDK、MCP Server、Admin server routes 和 nginx 代理是否使用同一契约。
- 涉及 Functions invoke 时，优先检查：
  - `functions.controller.ts`
  - `functions.service.ts`
  - `docker/deno-worker/*`
- 如新增需要匿名开放的函数能力，先确认 Worker 本身是否具备调用者身份校验。
- 涉及 GraphQL 代理限流时：
  - Redis key 必须包含 `projectId`
  - `perUser` 实际是“项目内 actor”限额，不是跨项目全局用户限额
  - 当前匿名 `apikey` 流量按 `request.ip` 归并，除非认证上下文先扩展出 API key identity
  - 若 API 部署在 nginx / ingress 后，必须开启 `TRUST_PROXY`；否则 `request.ip` 会退化为代理地址，匿名 GraphQL 限流会把多用户错误合并

## 近期风险

- MCP Server 当前使用的 API key 请求头和部分 schema 路由的身份要求仍需与 API 对齐，完成前不要把 MCP 标记为生产就绪。
- `invoke_auth_mode` 依赖数据库迁移；代码先行、数据库未升级时，管理端会报保存失败。
- 上传类函数若未做调用者鉴权，不应依赖平台层匿名放行。
- `druvia_projects.settings` 更新虽已改为 JSONB 顶层 merge，但 `rateLimits` 等嵌套对象仍不是深合并；路由和前端都不能误判。

## 参考入口

- `docs/agent/design-decisions.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
- `docs/plans/2026-03-19-apikey-auth-design.md`
- `docs/plans/2026-03-23-function-invoke-auth-ui-design.md`
