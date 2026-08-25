# Druvia Agent Notes

Codex 在本仓库的根级工作说明。进入子目录后，继续读取最近的局部 `AGENTS.md`；局部规则覆盖同主题的根规则。

## Product

- Druvia 是面向中文开发者的自托管 BaaS，体验目标接近 Supabase，底层以 Hasura GraphQL/Subscriptions 为核心。
- 当前产品默认按“单租户 + 多项目”理解；多租户能力保留为远期企业版方向。
- 当前阶段是 MVP 后的生产加固与迁移兼容，不应把“已有界面或接口”直接表述为生产能力已经闭环。

## Architecture

- `apps/admin`: Next.js 16 + React 19 管理后台
- `apps/api`: Fastify 5 管理层 API
- `apps/updater`: Docker Compose 在线升级控制面
- `packages/sdk`: `@druvia/sdk`
- `packages/mcp-server`: 实验性 MCP Server 原型（非生产运行链路）
- `packages/shared`: 共享类型与工具
- `hasura/metadata`: Hasura metadata
- `migrations`: SQL 迁移
- `docker`: Docker Compose、nginx、Deno worker、独立 Registry 部署包

技术底座为 Node.js 22、PostgreSQL 17、Hasura CE、Redis 7、Deno Worker、pnpm 和 turbo。

## Data And Identity

- 平台核心元数据位于 `public` schema。
- 业务数据按 tenant/project schema 隔离，当前实际运行更接近 Schema-per-Project。
- 权限主要依赖 Hasura permissions，不依赖 PostgreSQL RLS。
- 平台用户、项目终端用户、匿名项目 API key、trusted backend key 是不同身份边界，不得在新代码中合并语义。
- Project Data Access Batch 3A/3B 后，公开项目 GraphQL 和 Realtime token exchange 只接受同项目 `project_user` / `apikey`；平台 session 不能作为应用数据凭证，SDK 也不得把长期项目凭证直传 Hasura。
- Project Data Access Batch 4 后，已有 compatibility 项目只能通过迁移 `019` 支撑的预检/apply/recovery/rollback 状态机激活；不得直接修改 `data_access_mode`，不得绕过相关管理写锁。
- RPC 与 Functions 共用版本化 `ProjectActorContext`；SDK 的 RPC/Functions 只选择 Project Session 或项目 API Key，不得隐式回退 Platform Session。Functions 内部 GraphQL 必须使用服务端派生的 Hasura role/session variables，Platform User 不具备该应用数据能力。
- 直接 Storage 对象路由已完成 Project User cutover：bucket 使用 `admin_only / owner_only / authenticated_read` 三种预设，对象以 `owner_project_user_id` 判定所有权；公开下载是独立开关，trusted ticket/Functions 是独立 capability。
- SDK 直接 Storage 只选择 Project Session 或项目 API Key，不得使用 Platform Session；trusted ticket 方法只发送显式 trusted/ticket header。
- 改权限、GraphQL 代理、Realtime、Storage、Functions 或 SDK Auth 返回结构时，必须检查 Supabase 迁移和 taro-app 兼容路径。

## Current Priorities

1. 以真实 taro-app/H5/小程序完成 Project Auth、GraphQL、Realtime、Storage、RPC 和 Functions 全链路及生产上线验收，只修复实际阻塞、安全或正确性缺口。
2. 为 taro-app stable 基线补齐确定性的 build/lint/核心测试、migration、备份、健康检查和恢复门禁，再进入实际发布窗口。
3. 继续补齐真实迁移暴露的 SDK 能力，避免以抽象完整性替代迁移验证；足球应用、Swift、Recipe 和 Phase D 不阻塞 taro-app 上线。

完整现状和分阶段建议见 `docs/plans/2026-08-14-project-update-direction-analysis.md`。

## Repository Rules

- 修改前先读取当前目录链上的最近 `AGENTS.md`；模块规则放在最接近代码的目录，不堆入根文档。
- 优先相信当前代码与测试；文档冲突时，修正文档，不按过期叙事修改代码。
- 不要把 provider、adapter、路由或 UI 占位误判为完整可用。
- 权限和认证变更默认采用安全值；匿名能力必须按功能显式允许。
- 数据库结构变化必须同时检查 migration、Hasura metadata、回滚策略和旧部署升级路径。
- 发布与 OTA 改动必须检查 GHCR、自建 Registry、本地 release 演练和生产部署四条路径。
- Phase 开发、镜像构建、stable release 和生产 OTA 是独立动作；生产只跟随通过 taro-app 兼容回归的 stable manifest，并由运维人工 apply。
- 当前 `releases/latest/download` 尚未隔离 beta/nightly prerelease；生产跟随该入口期间，不得让非 stable 发布覆盖它。
- `packages/mcp-server` 当前只保留实验性原型；在明确管理型或项目型身份、完成真实 API 契约测试并解除私有包状态前，不得宣称可发布或用于生产。
- 不提交非 example 的 `.env` 配置、Registry 凭证、证书、数据库/Redis/Storage 运行数据或生产绝对路径。
- 保留用户已有未提交改动；不要使用破坏性 Git 命令。

## Subagent Collaboration

- 主 agent 对需求理解、实施计划、代码集成、最终验证和文档同步负责；子 agent 只承担边界清晰、可独立完成的辅助任务。
- 简单任务、强顺序任务和当前主流程的阻塞任务由主 agent 直接处理；不得为每个子任务机械启动 agent 或设置检查点。
- 仅在任务可并行、需要独立证据或需要专项复核时调用子 agent；同时运行不得超过全局配置的 3 个。
- `scout` 用于快速定位文件和符号；`explorer` 用于跨模块调用链与边界分析；`docs_researcher` 用于核对当前官方文档。
- 不得为同一问题同时调用职责重叠的子 agent；优先选择能够完成任务的最轻量角色。
- 常规变更完成后可调用 `reviewer`；身份权限、数据库迁移、数据完整性、发布或 OTA 等高风险变更使用 `critical_reviewer`。
- Druvia 默认由主 agent 在当前主工作区实施。`worker` 仅在用户明确授权并行实现，且需求、允许修改范围和验收条件已经明确时使用；任务之间的写入文件必须互斥，不得创建或依赖 `.worktrees`。
- 子 agent 必须遵守根目录及目标模块最近的 `AGENTS.md`，不得继续派生子 agent，不得覆盖已有未提交内容、扩大任务范围、commit、push 或修改外部系统。
- 主 agent 必须复核子 agent 的结论和改动；子 agent 的完成报告不能替代主流程的测试、review 和最终验证。
- 用户明确要求“不使用子 agent”或“直接在本会话处理”时，不得委派。

## Documentation Model

- `AGENTS.md`: Codex 自动发现的工作约束；根文件保存仓库级规则，局部文件保存子树规则。
- `docs/agent/design-decisions.md`: 已确认、应长期遵守的架构与安全决策。
- `docs/agent/playbooks.md`: 可重复执行的维护流程。
- `docs/progress.md`: 人类可读的阶段状态和下一步。
- `docs/plans/YYYY-MM-DD-*.md`: 日期化功能文档；同一功能的目标、设计决策、实施步骤、验收标准、验证证据和最终状态必须合并在同一文件中。
- `.agents/skills/*`: Codex 按需发现的仓库级可复用工作流；不能替代 `AGENTS.md` 的常驻作用域规则。
- `.claude/*` 仅为兼容现有 Claude 工作流，不是 Codex 的事实来源。

无论使用 Codex、Superpowers 或其他 agent 工作流，新功能都不得创建 `docs/superpowers`、`specs/plans` 双目录或独立的 `*-design.md` / `*-implementation.md` 配对文档。需要规划时，在 `docs/plans` 创建一份综合文档，并在实施过程中持续更新同一文件；历史拆分文档可以保留，但不得作为新文档模板。

仓库不维护额外的 `project-memory.md`。新事实必须按上述职责落入最近的 `AGENTS.md`、长期决策、进度或日期化文档，避免并行事实源漂移。

## Useful Files

- `docs/agent/design-decisions.md`
- `docs/agent/playbooks.md`
- `docs/progress.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
- `.agents/skills/druvia-doc-update/SKILL.md`
- `.agents/skills/taro-migration-memory/SKILL.md`
- `docs/platform-logging-guide.md`
