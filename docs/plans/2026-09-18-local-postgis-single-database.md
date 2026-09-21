# 本地 PostGIS 单库模式

## 目标

让当前使用 `docker/postgres_postgis_data` 的本地 PostGIS 开发数据库以唯一的逻辑服务 `postgres` 运行，不再同时启动普通 PostgreSQL；不移动、复制或删除任一数据库数据目录。

## 设计

共享的 `docker/docker-compose.postgis.yml` 继续只负责将主 Compose 的 `postgres` 服务替换为兼容的 PostGIS 镜像，并提供幂等的 `postgis-enable` 任务。

新增只用于本地的最终 overlay `docker/docker-compose.local.postgis.yml`。该文件只把逻辑服务 `postgres` 的数据挂载替换为 `./postgres_postgis_data`。因此 API 和 Hasura 保持连接 `postgres:5432`，而当前 PostGIS catalog、Hasura metadata 与项目数据无需迁移。`docker/postgres_data` 保留为未启动的普通 PostgreSQL 数据目录。

该模式不得与 `docker-compose.local.dual-db.yml` 同时使用。单库模式的宿主数据库端口为 `POSTGRES_PORT`（当前本地默认 `5532`）；`POSTGRES_POSTGIS_PORT` 和 `DRUVIA_LOCAL_DB_HOST=postgres-postgis` 仅属于双库模式。

## 实施步骤

1. 新增本地 PostGIS 数据目录 overlay，只覆盖 `postgres` 的 bind mount。
2. 更新 Docker 局部规则，区分通用 PostGIS 镜像 overlay、双库 overlay 与保留现有 PostGIS 数据的单库 overlay。
3. 在运维手册中记录切换前备份、停止/删除容器但保留 bind mount、单库启动、扩展验证及恢复普通单库的边界。
4. 渲染组合后的 Compose 配置，验证只存在一个 PostgreSQL 服务、其镜像为 PostGIS、其数据目录为 `postgres_postgis_data`，API 和 Hasura 均连接逻辑服务 `postgres`。

## 验收标准

- `docker-compose.local.yml`、`docker-compose.postgis.yml` 与本地单库 overlay 合并后不存在 `postgres-postgis` 服务。
- 渲染后的 `postgres` 使用 `postgis/postgis:17-3.5-alpine`（或环境变量指定的等价镜像）和 `docker/postgres_postgis_data`。
- 渲染后的 API `DB_HOST` 为 `postgres`，Hasura 数据库 URL 主机为 `postgres`。
- 文档禁止使用 `down -v`、`rm -v` 或删除两个数据库目录；不把物理数据目录复制当作迁移手段。

## 验证证据

2026-09-18 本地静态验证：

- 三份 Compose 文件经 `docker compose config --format json` 合并后，`postgres` 镜像为 `postgis/postgis:17-3.5-alpine`，数据目录为 `docker/postgres_postgis_data`。
- 渲染后的 API `DB_HOST` 和 Hasura database URL 主机均为 `postgres`。
- `config --services` 不包含 `postgres-postgis`。
- `git diff --check` 通过。

## 状态

已完成。本次未启动、停止、删除或重建本机容器，也未改动数据库目录。
