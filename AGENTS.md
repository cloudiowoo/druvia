# Druvia Agent Notes

Codex 项目上下文入口。用于快速建立当前仓库的稳定事实和工作优先级。

本仓库同时保留两套上下文体系：

- Claude 体系：`CLAUDE.md`、`.claude/memory/*`
- Codex 体系：`AGENTS.md`、子目录 `AGENTS.md`、`docs/agent/*`、`.codex/rules/*`、`.codex/skills/*`

对 Codex 来说，优先读取当前目录树内的 `AGENTS.md`，再按需查看 `docs/agent/*`。`.claude/*` 保留用于兼容现有工作流，不作为 Codex 的唯一入口。

## Product

- Druvia 是面向中文开发者的自托管 BaaS。
- 用户体验目标接近 Supabase，但底层以 Hasura GraphQL/Subscriptions 为核心。
- 当前产品策略默认按“单租户 + 多项目”理解。
- 多租户能力仍保留在架构和数据模型中，但更偏远期企业版，而不是当前默认产品叙事。

## Architecture

- `apps/admin`: Next.js 16 + React 19 管理后台
- `apps/api`: Fastify 5 管理层 API
- `packages/sdk`: `@druvia/sdk`
- `packages/mcp-server`: MCP Server
- `packages/shared`: 共享类型与工具
- `hasura/metadata`: Hasura metadata
- `migrations`: SQL 迁移
- `docker`: Docker Compose、nginx、Deno worker

技术底座：

- Node.js 22
- PostgreSQL 17
- Hasura CE
- Redis 7
- Deno Worker
- pnpm + turbo monorepo

## Data Model

- 平台核心元数据在 `public` schema。
- 业务数据按 tenant/project schema 隔离。
- 当前实际运行更接近 Schema-per-Project。
- 权限主要依赖 Hasura permissions，不依赖 PostgreSQL RLS。

## Current Stage

截至 2026-03-22：

- MVP 主体已完成，不再是纯骨架项目。
- Admin、API、Storage、Auth、Realtime、Functions、SQL、Tables、SDK 都已有真实实现。
- 当前重点在 SDK 补齐、Supabase 迁移兼容、权限模型细化、商业化前置能力。
- 真实迁移场景以 taro-app / Supabase -> Druvia 为牵引。

## What Exists

- 租户 / 项目管理
- Schema 管理与迁移体系
- 表管理、数据 CRUD、快速建表模板
- SQL 编辑器增强
- CSV 导入
- ER 图可视化
- Storage 管理界面与对象模型
- Auth 管理界面
- Realtime 管理界面
- Edge Functions 管理界面 + Deno worker
- API Key 管理
- Environment 管理
- RPC API
- MCP Server
- SDK 基础模块：auth / database / storage / realtime / rpc / functions

## Partial / Not Done

- Auth adapters:
  - 已实现：WeChat、OIDC
  - 未实现：DingTalk、Feishu、Enterprise WeChat、QQ
- Storage adapters:
  - 已实现：Local、R2
  - 未实现：S3 独立实现
- 国内 AI 集成仍是规划项
- Supabase 迁移 CLI 仍是规划项
- 商业化能力仍主要停留在策略与路线图

## Recent Important Changes

- SDK 已补齐或正在补齐：
  - `maybeSingle()`
  - `.or()`
  - `.not()`
  - `removeChannel()`
  - `auth.refreshSession()`
  - `auth.updateUser()`
- API 已支持 `apikey` fallback 认证。
- Realtime 权限已引入 `_meta_tables.realtime_enabled`，开始与表管理权限解耦。
- Functions invoke 权限已收敛为函数级 `invoke_auth_mode`：
  - 默认 `jwt_required`
  - 仅显式标记 `anon_allowed` 的函数允许同项目匿名 `apikey` 调用
  - Admin 修改该字段前必须先应用 `015_function_invoke_auth_mode` 迁移

## Working Rules

- 讨论“当前产品”时，默认按单租户 + 多项目理解。
- 改权限、GraphQL 代理、SDK Auth 返回结构时，优先检查 Supabase 迁移和 taro-app 兼容需求。
- 不要把“接口已预留”误判成“provider 已完整可用”。
- 需要更新“项目记忆”时，优先写入 `docs/agent/*`；只有仍需兼容 Claude 工作流时，才补充 `.claude/*`。
- 需要新增模块特有约束时，优先在对应子目录新增或更新局部 `AGENTS.md`，不要把所有细节堆回根文档。
- 若设计文档与代码冲突，优先相信：
  1. 当前代码
  2. 最近实施文档
  3. `docs/agent/design-decisions.md`
  4. `.claude/memory/design-decisions.md`

## Document Drift To Watch

- `CLAUDE.md` 仍保留较多早期叙事和版本信息。
- `docs/migration/supabase-compat.md` 可能落后于当前代码。
- 发布文档写到 `v0.2.0`，但多个 package version 仍为 `0.1.0`。

## Useful Files

- `CLAUDE.md`
- `docs/agent/project-memory.md`
- `docs/agent/design-decisions.md`
- `docs/agent/playbooks.md`
- `.codex/rules/project.rules.md`
- `.codex/rules/docs.rules.md`
- `.codex/skills/druvia-doc-update/SKILL.md`
- `.codex/skills/taro-migration-memory/SKILL.md`
- `.claude/memory/design-decisions.md`
- `.claude/memory/project-memory.md`
- `docs/plans/2026-03-03-druvia-strategy-design.md`
- `docs/plans/2026-03-10-commercialization-strategy.md`
- `docs/plans/2026-03-17-taro-app-migration-design.md`
- `docs/plans/2026-03-18-druvia-sdk-adapter-requirements.md`
- `docs/plans/2026-03-21-realtime-permission-decoupling.md`
