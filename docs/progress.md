# Druvia Progress

项目阶段进展摘要。用于记录人类可读的里程碑、当前状态与下一步，而不是每个小任务的流水账。

## Update Policy

- 仅在阶段性完成、关键阻塞解除、跨子项目影响明确时更新
- 用户显式要求同步项目进度时也应更新
- 小修、小范围重构、纯文案调整不应默认写入本文件

## Current Snapshot

- 当前项目已进入 MVP 后的生产加固与迁移兼容阶段
- 真实需求牵引以 taro-app / Supabase -> Druvia 迁移为主
- 后续采用“应用驱动平台演进”框架：taro-app 验证迁移兼容，足球运动数据应用验证原生移动端、离线批量、Storage 和后台分析场景
- 新需求按 `Core / Optional Capability / Application Domain` 分层，只有平台安全基础或经跨应用验证的通用能力进入 Core
- 近期最高优先级是 Hasura 默认权限、project-user 全链路身份、发布门禁、OTA 恢复和 MCP 契约
- 项目整体评估与分阶段路线已归档到 `docs/plans/2026-08-14-project-update-direction-analysis.md`
- 应用驱动的未来开发框架已归档到 `docs/plans/2026-08-17-application-driven-development-framework.md`
- Codex 项目说明已改为官方 `AGENTS.md` 分层模型，不再维护平行的 `project-memory.md`

## Recent Milestones

- Project Data Access Batch 1 已建立安全 metadata 基线：表 tracking 不再自动生成宽泛 CRUD permissions，Realtime 开关不再修改 select permission，Admin 默认改用数据接口/实时更新语义展示就绪状态；当前 SDK WebSocket 仍按 `anonymous` select permission 判定可用，正式 actor 鉴权留待后续批次
- 已引入版本化 data-scope role resolver 作为后续项目角色、环境作用域和 service principal 的内部扩展基础；现有项目尚未切换到 scoped role，需等待显式权限编辑和迁移批次
- Project Data Access Batch 2A 已落地默认生产 schema 的表级访问配置：认证用户 CRUD 支持关闭/全部记录/仅自己的记录，匿名侧仅支持读取；保存只原子替换当前项目受管 scoped roles，保留旧角色和自定义规则，HTTP/WebSocket actor 尚未切换

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
  - `.agents/skills/*`
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
- 平台侧已补齐 trusted backend access Phase 1 第一批正式能力：
  - `trusted backend key` 数据模型与项目级管理 API
  - trusted project session issuer
  - trusted storage upload/remove ticket issuer
  - trusted storage upload/remove consume routes
  - SDK `projectAuth` / `storage` trusted helper
  - storage ticket 上传审计写入 `druvia_storage_objects.metadata`
- 平台日志 Phase 1 已落地第一批基础能力：
  - `packages/shared` 新增结构化日志契约与错误序列化 helper
  - API 首批高价值模块已接入结构化 stdout/stderr
  - Deno Worker 已输出执行级日志，并为函数内 `console.*` 注入统一结构化包装
  - MCP Server 已覆盖启动、鉴权失败、fatal 等关键日志事件
  - Admin 服务端 API wrapper 已覆盖上游 API 失败、无效响应、网络异常等最小结构化日志
- 平台日志 Phase 2 已补齐官方可选部署示例：
  - `docker-compose.local.yml` / `docker-compose.prod.yml` 新增 `with-logs` profile
  - 提供 `Loki + Promtail + Grafana` 最小可用配置
  - 新增 `docs/platform-logging-guide.md` 说明启动方式、标签约定与查询示例
- Admin Tables 已补齐 Hasura schema 刷新能力：
  - 新增 `刷新 Hasura Schema` 按钮
  - `addColumn` / `dropColumn` / `renameColumn` 后自动 reload metadata
  - 与原有 `同步 GraphQL 权限` 操作分离
- Docker Compose 在线升级初版已落地：
  - 新增 release-mode compose、worker/updater Dockerfile、`.env.release.example`
  - 新增 `apps/updater` 内部服务，支持 manifest 校验、镜像拉取、staged release、apply、restart、rollback
  - 新增 GitHub release workflow 和 manifest 生成脚本
  - API 新增 super_admin-only system update 代理路由
  - Admin 新增被动更新通知和系统设置页更新操作面板
  - release-mode compose 已新增 `with-local-nginx` profile，可用 GHCR/GitHub Release 发布物在本地通过 `http://localhost:8088` 同源演练 OTA
  - release/prod/local compose 已统一使用 `docker/storage_data` 作为本地 storage 默认持久化目录，生产 release 初始化不再依赖源码 `apps/` 目录
  - 新增独立 `docker/registry/` 部署包，支持在国内云主机/NAS 上自建 `registry:2` 作为生产可访问镜像源
  - GitHub release workflow 已改为同时推送 GHCR 与自建 Registry 镜像，并生成 `release-manifest.json` / `release-manifest.cn.json` 供客户端按环境选择 OTA 源
  - updater 自更新已改为一次性 finalizer 容器执行；apply 后进入 `finalizing`，finalizer 写回 completed/failed 状态并自动清理自身容器
  - Admin 系统更新面板已补齐阶段进度、更新详情弹窗与进行中反馈；顶部被动通知覆盖下载、应用、验证、收尾等后台阶段

## Current Next Steps

- 补齐 Project Data Access Batch 2B 项目概览，并在 Batch 3 实现 scoped role 的 HTTP/WebSocket actor 切换与项目激活状态
- 统一 project-user 在 GraphQL、Realtime、Storage、RPC 和 Functions 中的身份传播与审计
- 修正 MCP Server 与 API 的认证头、路由身份和 scope 契约，并增加真实 API 契约测试
- 将 build、lint、核心测试、manifest/digest 校验和 OTA smoke test 纳入 release 门禁
- 在生产目标主机重新生成 release 路径配置，完成 `0.3.3 -> 0.3.4+` 的 apply/finalizer 验收
- 分别演练 GHCR 与自建 Registry 更新源、故障镜像回滚和数据库 dump 恢复
- 继续用 taro-app 迁移验证 project auth、Storage helper、Realtime 重连和 SDK token 选择顺序
- 在权限和发布基线稳定后，以足球运动数据应用验证原生客户端、批量写入、IMU Storage 和 Trusted Backend Worker；领域模型与算法保留在应用侧
- 根据真实应用证据决定 PostgreSQL 扩展入口、Swift SDK 和 Recipe 的晋升，暂不建设通用 Jobs、Queue 或 Worker Runtime
- 补齐公开仓库 README、LICENSE、敏感信息历史检查和版本轴说明
