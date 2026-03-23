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

- 继续验证 Admin 侧 `invokeAuthMode` 保存链路在迁移执行后是否正常
- 将 `wx-login-register` 等旧函数从直连 Hasura admin 方案迁移到 `druvia.graphql()`
- 持续把 taro-app 迁移中沉淀出的高价值结论同步到 Codex 项目记忆体系
