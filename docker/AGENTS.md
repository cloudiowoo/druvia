# Docker Agent Notes

适用于 `docker` 目录及其子树。

## 部署模式

- `docker-compose.local.yml`: 本地源码开发依赖与服务
- `docker-compose.prod.yml`: 传统生产构建/部署
- `docker-compose.release.yml`: 版本镜像部署和 OTA
- `registry/docker-compose.yml`: 独立 Registry 部署包，必须可在另一台服务器单独运行

## 工作规则

- release-mode 同时支持 GHCR 和自建 Registry；客户端通过 manifest URL 和初始镜像前缀选择来源，不在运行中混用两个 manifest 的 digest。
- `.env.prod` 与 `.env.release` 是部署主机配置，不提交 Git；仓库只维护对应 example。
- `DRUVIA_DEPLOY_DIR`、`DRUVIA_BASE_ENV_FILE`、`DRUVIA_RELEASE_ENV_FILE` 和 `DRUVIA_COMPOSE_FILE` 必须按目标宿主机重新生成，不能从开发机直接复制绝对路径。
- `docker/storage_data` 是本地存储持久化目录；只提交 `.gitkeep`，不提交对象数据。
- 生产证书续期继续由 certbot 流程管理。release-mode 下续期脚本必须加载 release compose/env，续期后 reload/recreate nginx 使新证书生效。
- 本地 OTA 使用 `with-local-nginx` 和 HTTP；生产内置 nginx 使用 `with-nginx` 和证书。不要把本地 profile 写入生产 `.env.release`。
- Registry 部署与 Druvia 主服务 compose 保持独立，不增加主项目默认依赖。
- local/prod/release 的单库 PostGIS 部署只通过 `docker-compose.postgis.yml` 叠加到主 Compose；默认部署继续使用 `postgres:17-alpine`。本地若要将已有双库 PostGIS 数据以单库方式运行，再在最后叠加 `docker-compose.local.postgis.yml`，它只把逻辑 `postgres` 的数据目录改为 `postgres_postgis_data`。该本地 overlay 不得与 `docker-compose.local.dual-db.yml` 同时使用，也不得用于 prod/release。数据库镜像和扩展生命周期由运维人工管理，不纳入普通 OTA。PostGIS 仍启用或继续使用原数据目录期间，人工 `up`、恢复和数据库操作必须携带所需 override；只有按 playbook 完成无依赖卸载，或把启用前备份恢复到新的普通 PostgreSQL 17 数据目录后，才能停止使用 override。已存在 PostGIS 依赖对象时，不得将同一数据目录直接切回普通 PostgreSQL 镜像，也不得用 `DROP EXTENSION ... CASCADE` 伪装回退。
- `docker-compose.local.dual-db.yml` 仅用于本地并行验证：普通 PostgreSQL 始终使用默认服务名 `postgres` 和 `postgres_data`，PostGIS 使用 `postgres-postgis` 和 `postgres_postgis_data`。两套目录是独立数据库，不自动同步，也不得直接复制运行中的物理数据目录；生产、release 和 OTA 仍保持单 PostgreSQL 实例。
- API 与 Deno Worker 必须共享同一个至少 32 UTF-8 字节的 `DENO_WORKER_SECRET`；生产推荐与 `FUNCTIONS_INTERNAL_TOKEN_SECRET`、`JWT_SECRET` 分离。Worker 不能接收 Function token 签名密钥。
- `local/prod/release` 不发布 Worker 的宿主端口；仅宿主机运行 API 的基础/dev compose 可绑定 `127.0.0.1:${DENO_PORT:-7133}:7133`。所有模式必须保留 Worker `/health` healthcheck。
- Function 子 Worker 必须保持 `env: false`；项目 Function secrets 只能通过每次调用独立的 `Deno.env` shim 提供，不能暴露容器环境。
- Worker 请求鉴权协议升级时，新 API 必须先健康再替换 Worker；自动与手动回滚都先恢复旧 Worker，再恢复完整服务集。

## Subagent Triggers

- Compose、Registry、nginx 或 certbot 的版本化行为需要外部依据时使用 `docs_researcher` 核对官方文档。
- OTA、证书、持久化数据、双 Registry 发布或回滚变更在最终验证前必须使用 `critical_reviewer`。

## Release Verification

- 变更 compose 或 env 契约后，分别执行 local、prod、release 配置渲染检查。
- OTA 变更必须验证 GHCR manifest、自建 Registry manifest、旧版本到新版本升级、故障回滚和 updater finalizer。
- 发布前确认敏感文件、证书、数据库、Redis、Storage、Registry auth 数据均被忽略。

## 参考入口

- `docs/agent/design-decisions.md`
- `docs/plans/2026-07-28-compose-ota-update-implementation.md`
- `docs/plans/2026-08-14-project-update-direction-analysis.md`
