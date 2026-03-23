# Druvia Progress

项目阶段进展摘要。用于记录人类可读的里程碑、当前状态与下一步，而不是每个小任务的流水账。

## Update Policy

- 仅在阶段性完成、关键阻塞解除、跨子项目影响明确时更新
- 用户显式发送 `/update_progress` 或 `/sync_memory` 时也应更新
- 小修、小范围重构、纯文案调整不应默认写入本文件

## Current Snapshot

- 当前项目已进入 MVP 后的能力补齐与迁移兼容阶段
- 真实需求牵引以 taro-app / Supabase -> Druvia 迁移为主
- 近期重点是 SDK 补齐、权限模型细化、Functions invoke 安全收敛
- Codex 项目级记忆、rules、skills 结构已建立，后续可按显式命令和重大认知变更同步

## Recent Milestones

- API 已支持 `apikey` fallback 认证
- Realtime 权限开始与表管理权限解耦
- Functions invoke 已引入函数级 `invoke_auth_mode`
- Admin Functions 页面已补充 `invokeAuthMode` 的展示与编辑能力
- 项目终端用户 Auth Phase 1 已落地第一批核心能力：
  - `project-auth` API 路由
  - provider 通用核心与 `/:provider/login` 路由
  - 项目级 refresh token 基础设施
  - `platform_user / project_user / apikey` 身份分流
  - Functions `jwt_required` 接受同项目 `project_user`
  - RPC 接受同项目 `project_user`
  - SDK `client.projectAuth` 与独立 project session 存储
- 仓库已补齐 Codex 原生项目上下文体系：
  - 根与模块 `AGENTS.md`
  - `docs/agent/*`
  - `.codex/rules/*`
  - `.codex/skills/*`
- 平台侧已补齐 Edge Function internal GraphQL 基础能力：
  - internal token
  - `/api/internal/functions/graphql`
  - 运行时 `druvia.graphql()` helper

## Current Next Steps

- 将 taro-app 的 `wx-login-register` / `wx-silent-login` 切换到平台 project auth API
- 评估并规划 GraphQL project-user 能力的下一阶段设计
- 继续把旧 Edge Function 登录函数收敛为薄代理或下线
- 持续把 taro-app 迁移中沉淀出的高价值结论同步到 Codex 项目记忆体系
