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
- 平台侧已补齐终端用户图片上传 Phase 1 基础能力：
  - `/api/internal/functions/storage/upload`
  - `/api/internal/functions/storage/remove`
  - 运行时 `druvia.storage.upload()` / `druvia.storage.remove()`
  - storage 审计信息写入 `druvia_storage_objects.metadata`
  - taro-app 风格上传函数后续可去掉 `DRUVIA_TOKEN`
- 平台日志 Phase 1 已落地第一批基础能力：
  - `packages/shared` 新增结构化日志契约与错误序列化 helper
  - API 首批高价值模块已接入结构化 stdout/stderr
  - Deno Worker 已输出执行级日志，并为函数内 `console.*` 注入统一结构化包装
  - MCP Server 已覆盖启动、鉴权失败、fatal 等关键日志事件
  - Admin 服务端 API wrapper 已覆盖上游 API 失败、无效响应、网络异常等最小结构化日志
- Admin Tables 已补齐 Hasura schema 刷新能力：
  - 新增 `刷新 Hasura Schema` 按钮
  - `addColumn` / `dropColumn` / `renameColumn` 后自动 reload metadata
  - 与原有 `同步 GraphQL 权限` 操作分离

## Current Next Steps

- 将 taro-app 的 `wx-login-register` / `wx-silent-login` 切换到平台 project auth API
- 将 taro-app 的 `upload-avatar` / `upload-team-logo` 改为调用 `druvia.storage.upload()`，并在需要新文件名替换时配合 `druvia.storage.remove()`
- 评估并规划 GraphQL project-user 能力的下一阶段设计
- 继续把旧 Edge Function 登录函数收敛为薄代理或下线
- 持续把 taro-app 迁移中沉淀出的高价值结论同步到 Codex 项目记忆体系
- 继续扩展平台日志覆盖面：
  - Admin 服务端日志
  - 更多 API 模块的 `console.*` 收敛
  - Phase 2 可选日志部署方案文档
