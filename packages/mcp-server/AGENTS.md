# MCP Server Agent Notes

适用于 `packages/mcp-server` 目录及其子树。

## 模块职责

- 将 Druvia 能力暴露为 MCP tools
- 管理 MCP 输入校验、API 调用、错误映射和结构化日志

## 工作规则

- 先明确工具属于平台管理能力还是项目级能力，再选择凭证；不要用同一 API key 模糊覆盖两种身份。
- 请求头、route、scope 和响应 envelope 必须与 `apps/api` 的真实中间件及 controller 契约一致。
- 不得因为 MCP tool 已注册就宣称能力可用；必须通过真实 API 契约测试验证。
- 管理型工具默认要求平台身份或专用管理凭证。项目 key 只允许访问同项目且显式开放的能力。
- 日志不得输出 bearer token、API key、trusted backend key 或完整用户输入中的 secret。

## 当前风险

- 现有 API key 请求头与 API 中间件读取方式需要统一。
- 部分 schema 路由仍是 platform-user-only，不能直接由项目 API key 调用。

## 参考入口

- `apps/api/AGENTS.md`
- `docs/agent/design-decisions.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`

