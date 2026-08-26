# Druvia Playbooks

常用操作手册。用于新会话快速恢复高频验证和排查动作。

## 运行常用验证

- API 定向构建：
  - `pnpm --filter @druvia/api build`
- Functions 相关单测：
  - `pnpm test tests/unit/functions-controller.test.ts tests/unit/functions-service.test.ts tests/unit/api-app.test.ts`
- Edge Function internal GraphQL 相关单测：
  - `pnpm test tests/unit/functions-internal-token.test.ts tests/unit/functions-internal-graphql.test.ts tests/unit/druvia-helper.test.ts`
- Admin 侧 invoke auth helper 单测：
  - `pnpm test tests/unit/admin/function-invoke-auth-mode.test.ts`

## 数据库迁移

- 查看代码 migration 与目标数据库的版本状态：
  - `pnpm migrate status`
- 执行全部未应用迁移：
  - `pnpm migrate up`
- migration CLI 从仓库根 `.env` 读取 `DB_HOST / DB_PORT / DB_USER / POSTGRES_PASSWORD / DB_NAME`。若目标容器不是该端口，先修正 Compose/env 契约；临时诊断可显式使用 `DB_PORT=<实际宿主端口> pnpm migrate status`，但不要长期依赖命令行覆盖掩盖环境漂移。

## 可选 PostGIS 部署

`docker/docker-compose.postgis.yml` 是 local、prod、release 共用的可选 overlay，只替换 PostgreSQL 镜像并提供 `postgis-enable` 一次性任务。默认 Druvia 部署仍使用 `postgres:17-alpine`。OTA 不管理 PostgreSQL/PostGIS 镜像，也不会自动升级或回退数据库扩展。

- 切换已有数据库前先完成 custom archive 备份并验证 `pg_restore -l` 可读取；不得把镜像切换当作数据库备份。
- overlay 默认使用与 Druvia 相同主版本的 `postgis/postgis:17-3.5-alpine`，并固定 `linux/amd64`；ARM 主机依赖 Docker 模拟。生产可通过 `DRUVIA_POSTGRES_IMAGE` 固定已验证的 tag 或 digest，通过 `DRUVIA_POSTGRES_PLATFORM` 覆盖平台，但不得改用 PostgreSQL 18 直接挂载现有 PostgreSQL 17 数据目录。

### 本地双库并行与切换

本地需要保留普通 PostgreSQL 基线并独立开发 PostGIS 数据时，使用 `docker-compose.local.dual-db.yml`。

#### 日常速查（重点）

| 用途 | 普通 PostgreSQL | PostGIS |
| --- | --- | --- |
| Compose 服务 | `postgres` | `postgres-postgis` |
| 容器 | `druvia-postgres` | `druvia-postgres-postgis` |
| 数据目录 | `docker/postgres_data` | `docker/postgres_postgis_data` |
| 宿主端口 | `5532` | `5632`（默认） |
| `DRUVIA_LOCAL_DB_HOST` | `postgres`（默认） | `postgres-postgis` |

日常只需记住以下顺序：

1. 两套数据库可以同时运行，但 API 与 Hasura 一次只能使用一个目标。
2. 切换前从当前 Hasura 导出 canonical metadata，再修改 `docker/.env` 的 `DRUVIA_LOCAL_DB_HOST`。
3. 停止 `api/admin/hasura/deno`，先重建目标 Hasura 并应用 canonical metadata。
4. Hasura 一致、目标数据库 SQL/migration readiness 通过后，再启动 API。
5. API liveness 通过后才启动 Admin 与 Deno；任一步失败都保持后续服务停止，并恢复原目标。

常规冷启动先只启动两套数据库和 Redis；应用服务继续执行下方“完整安全切换命令”，不能用无门禁的全量 `up -d` 代替：

```bash
cd /Users/cloudio/Developer/nodejs/Druvia/docker

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  up -d postgres postgres-postgis redis

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  ps
```

切换前必须确认目标库已经完成 migration 和 metadata 初始化。普通库与 PostGIS 数据相互独立，切换不会复制或同步数据。完整切换命令见下方折叠区。

#### 固定边界

- `postgres` / `docker/postgres_data`：普通 PostgreSQL，默认目标，保持与其他部署模式一致。
- `postgres-postgis` / `docker/postgres_postgis_data`：本地可选 PostGIS，宿主端口默认 `127.0.0.1:5632`。
- 两套数据库拥有独立 catalog、migration、Hasura metadata 和业务数据；切换连接不会复制或同步数据。
- 该 overlay 只用于本地开发，不能与 `docker-compose.postgis.yml` 同时使用，也不改变生产、release 或 OTA 的单库模型。

<details>
<summary><strong>首次初始化或重置 PostGIS（低频操作）</strong></summary>

> 该流程会重建 PostGIS 目标数据库。已有且需要保留的 `postgres_postgis_data` 不应执行本段。

首次先确认 Compose 渲染仍以普通库为默认，再拉起两套数据库和导出 metadata 所需的普通库基线服务；不要把空的 PostGIS 数据库直接作为应用目标：

```bash
set -euo pipefail

cd /Users/cloudio/Developer/nodejs/Druvia/docker

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  config --format json \
  | jq -e '.services.api.environment.DB_HOST == "postgres"
      and (.services.hasura.environment.HASURA_GRAPHQL_DATABASE_URL
        | contains("@postgres:5432/druvia"))' > /dev/null

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  up -d postgres postgres-postgis redis api hasura

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  ps

HASURA_READY=0
for _ in $(seq 1 60); do
  if docker exec druvia-hasura \
    curl -fsS http://localhost:8080/healthz > /dev/null 2>&1; then
    HASURA_READY=1
    break
  fi
  sleep 2
done
test "$HASURA_READY" = "1"
```

新建或明确需要重置 `postgres_postgis_data` 时，先确认应用仍指向普通库，分别备份普通库、现有 PostGIS 库和 Hasura metadata。业务归档明确排除 `hdb_catalog`，避免把 event/scheduled-event 等运行队列复制到另一实例；metadata 通过 Hasura API 单独迁移。当前流程只支持没有 Hasura event trigger 的基线，双重门禁失败时必须停止并设计专项 trigger 迁移，不能删除检查或忽略错误：

```bash
set -euo pipefail
cd /Users/cloudio/Developer/nodejs/Druvia/docker

STAMP="$(date +%F_%H%M%S)"
BACKUP_DIR="$HOME/backups/druvia"
PLAIN_BACKUP="$BACKUP_DIR/druvia_local_plain_before_postgis_$STAMP.dump"
POSTGIS_BACKUP="$BACKUP_DIR/druvia_local_postgis_before_reset_$STAMP.dump"
METADATA_BACKUP="$BACKUP_DIR/druvia_local_hasura_metadata_$STAMP.json"
mkdir -p "$BACKUP_DIR"

test "$(docker inspect druvia-api --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^DB_HOST=//p')" = "postgres"
test "$(docker inspect druvia-hasura --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's#^HASURA_GRAPHQL_DATABASE_URL=.*@\([^:]*\):5432/druvia$#\1#p')" = "postgres"
test "$(docker inspect druvia-postgres-postgis \
  --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}')" \
  = "$(pwd)/postgres_postgis_data"

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  stop api admin deno

docker exec druvia-hasura sh -lc '
curl -fsS -X POST http://localhost:8080/v1/metadata \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -d "{\"type\":\"export_metadata\",\"args\":{}}"
' > "$METADATA_BACKUP"
jq -e '.version and .sources' "$METADATA_BACKUP" > /dev/null

jq -e '[.. | objects | select(has("event_triggers")) | .event_triggers[]?]
  | length == 0' "$METADATA_BACKUP" > /dev/null
test "$(docker exec druvia-postgres \
  psql -X -U postgres -d druvia -Atc \
  "SELECT count(*)
     FROM pg_trigger t
     JOIN pg_proc p ON p.oid = t.tgfoid
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE NOT t.tgisinternal AND n.nspname = 'hdb_catalog';")" = "0"

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  stop hasura

docker exec druvia-postgres \
  pg_dump -U postgres -d druvia \
  -Fc --no-owner --no-privileges -N hdb_catalog \
  > "$PLAIN_BACKUP"

docker exec druvia-postgres-postgis \
  pg_dump -U postgres -d druvia \
  -Fc --no-owner --no-privileges \
  > "$POSTGIS_BACKUP"

test -s "$PLAIN_BACKUP"
test -s "$POSTGIS_BACKUP"
docker exec -i druvia-postgres pg_restore -l < "$PLAIN_BACKUP" > /dev/null
docker exec -i druvia-postgres-postgis pg_restore -l < "$POSTGIS_BACKUP" > /dev/null

docker exec druvia-postgres-postgis \
  dropdb -U postgres --if-exists --force druvia
docker exec druvia-postgres-postgis \
  createdb -U postgres -T template0 -O postgres druvia
docker exec -i druvia-postgres-postgis \
  pg_restore -U postgres -d druvia \
  --no-owner --no-privileges --exit-on-error \
  < "$PLAIN_BACKUP"
```

随后显式启用扩展，从实际容器端口映射解析 migration 目标，并在执行前确认数据库身份。`DB_HOST` / `DB_PORT` 命令行值会覆盖仓库根 `.env`；执行前仍要确认两套数据库使用相同的本地密码：

```bash
set -euo pipefail
cd /Users/cloudio/Developer/nodejs/Druvia/docker

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  --profile postgis-tools \
  run --rm postgis-enable

POSTGIS_HOST_PORT="$(docker inspect druvia-postgres-postgis \
  --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}')"
test -n "$POSTGIS_HOST_PORT"

docker exec druvia-postgres-postgis \
  psql -X -U postgres -d druvia -v ON_ERROR_STOP=1 \
  -c "SELECT current_database(), current_setting('server_version_num'),
             (SELECT system_identifier FROM pg_control_system());"

cd ..
DB_HOST=127.0.0.1 DB_PORT="$POSTGIS_HOST_PORT" pnpm migrate up
cd docker

docker exec druvia-postgres-postgis \
  psql -X -U postgres -d druvia \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'postgis';"
```

将 `.env` 的 `DRUVIA_LOCAL_DB_HOST` 改为 `postgres-postgis`，先只启动 Hasura 并应用刚导出的 metadata；`replace_metadata` 失败或产生 inconsistent metadata 时，不得启动应用服务：

```bash
set -euo pipefail
cd /Users/cloudio/Developer/nodejs/Druvia/docker

# 改为上面导出并已通过 jq 验证的绝对路径。
METADATA_BACKUP="/absolute/path/to/druvia_local_hasura_metadata.json"
test -s "$METADATA_BACKUP"

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  up -d --no-deps --force-recreate hasura

HASURA_READY=0
for _ in $(seq 1 60); do
  if docker exec druvia-hasura \
    curl -fsS http://localhost:8080/healthz > /dev/null 2>&1; then
    HASURA_READY=1
    break
  fi
  sleep 2
done
test "$HASURA_READY" = "1"

jq -n --slurpfile metadata "$METADATA_BACKUP" \
  '{type:"replace_metadata",args:{allow_inconsistent_metadata:false,metadata:$metadata[0]}}' \
  | docker exec -i druvia-hasura sh -lc '
      curl -fsS -X POST http://localhost:8080/v1/metadata \
        -H "Content-Type: application/json" \
        -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
        --data-binary @-
    '

docker exec druvia-hasura sh -lc '
curl -fsS -X POST http://localhost:8080/v1/metadata \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -d "{\"type\":\"get_inconsistent_metadata\",\"args\":{}}"
' | jq -e '.is_consistent == true and (.inconsistent_objects | length == 0)'
```

已有且需要保留的 `postgres_postgis_data` 时不要执行上述重置；先检查 `druvia_schema_versions`、业务数据和 PostGIS 扩展，再仅执行确有需要的 migration。`.env` 默认保持 `DRUVIA_LOCAL_DB_HOST=postgres`。只有初始化、metadata apply 或已有库校验完成后，才能将其改为 `postgres-postgis`，然后重建其余数据库客户端服务：

```bash
set -euo pipefail
cd /Users/cloudio/Developer/nodejs/Druvia/docker

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  up -d --no-deps --force-recreate api admin deno
```

##### 重置失败时恢复原 PostGIS

如果 restore、migration 或 metadata apply 任一步失败，保持应用客户端停止，并将 `.env` 保持或恢复为 `postgres`。使用重置前已验证的 `$POSTGIS_BACKUP` 恢复原 PostGIS 数据库：

```bash
set -euo pipefail
cd /Users/cloudio/Developer/nodejs/Druvia/docker

# 改为上面生成并已通过 pg_restore -l 验证的绝对路径。
POSTGIS_BACKUP="/absolute/path/to/druvia_local_postgis_before_reset.dump"
test -s "$POSTGIS_BACKUP"
docker exec -i druvia-postgres-postgis pg_restore -l \
  < "$POSTGIS_BACKUP" > /dev/null

docker exec druvia-postgres-postgis \
  dropdb -U postgres --if-exists --force druvia
docker exec druvia-postgres-postgis \
  createdb -U postgres -T template0 -O postgres druvia
docker exec -i druvia-postgres-postgis \
  pg_restore -U postgres -d druvia \
  --no-owner --no-privileges --exit-on-error \
  < "$POSTGIS_BACKUP"

docker exec druvia-postgres-postgis \
  psql -X -U postgres -d druvia -v ON_ERROR_STOP=1 \
  -c "SELECT max(version) AS migration_version FROM druvia_schema_versions;
      SELECT extname, extversion FROM pg_extension WHERE extname = 'postgis';"
```

恢复成功后仍应使用下方完整安全切换流程重新选择 PostGIS；在 metadata consistency 和数据库 readiness 通过前不得启动 API/Admin/Deno。

</details>

<details>
<summary><strong>普通 PostgreSQL / PostGIS 完整安全切换命令</strong></summary>

切换前先从当前运行目标导出 canonical metadata；导出成功后再修改 `.env` 的 `DRUVIA_LOCAL_DB_HOST`：

```bash
set -euo pipefail
cd /Users/cloudio/Developer/nodejs/Druvia/docker

METADATA_BACKUP="${TMPDIR:-/tmp}/druvia-local-switch-metadata.json"
docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  up -d --no-deps hasura

HASURA_READY=0
for _ in $(seq 1 60); do
  if docker exec druvia-hasura \
    curl -fsS http://localhost:8080/healthz > /dev/null 2>&1; then
    HASURA_READY=1
    break
  fi
  sleep 2
done
test "$HASURA_READY" = "1"

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  stop api admin deno

docker exec druvia-hasura sh -lc '
curl -fsS -X POST http://localhost:8080/v1/metadata \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -d "{\"type\":\"export_metadata\",\"args\":{}}"
' > "$METADATA_BACKUP"
jq -e '.version and .sources' "$METADATA_BACKUP" > /dev/null
```

修改目标后，按 Hasura、数据库 readiness、API、Admin/Deno 的顺序恢复，避免 API 与 Hasura 在切换期间连接不同数据库：

```bash
set -euo pipefail
cd /Users/cloudio/Developer/nodejs/Druvia/docker
METADATA_BACKUP="${TMPDIR:-/tmp}/druvia-local-switch-metadata.json"
test -s "$METADATA_BACKUP"

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  stop api admin hasura deno

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  up -d --no-deps --force-recreate hasura

HASURA_READY=0
for _ in $(seq 1 60); do
  if docker exec druvia-hasura \
    curl -fsS http://localhost:8080/healthz > /dev/null 2>&1; then
    HASURA_READY=1
    break
  fi
  sleep 2
done
test "$HASURA_READY" = "1"

jq -n --slurpfile metadata "$METADATA_BACKUP" \
  '{type:"replace_metadata",args:{allow_inconsistent_metadata:false,metadata:$metadata[0]}}' \
  | docker exec -i druvia-hasura sh -lc '
      curl -fsS -X POST http://localhost:8080/v1/metadata \
        -H "Content-Type: application/json" \
        -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
        --data-binary @-
    '
docker exec druvia-hasura sh -lc '
curl -fsS -X POST http://localhost:8080/v1/metadata \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -d "{\"type\":\"get_inconsistent_metadata\",\"args\":{}}"
' | jq -e '.is_consistent == true and (.inconsistent_objects | length == 0)'

TARGET="$(docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  config --format json | jq -r '.services.api.environment.DB_HOST')"
case "$TARGET" in
  postgres) DB_CONTAINER=druvia-postgres ;;
  postgres-postgis) DB_CONTAINER=druvia-postgres-postgis ;;
  *) printf 'Unexpected database target: %s\n' "$TARGET" >&2; exit 1 ;;
esac

docker exec "$DB_CONTAINER" \
  psql -X -U postgres -d druvia -v ON_ERROR_STOP=1 \
  -c 'SELECT 1;'

EXPECTED_MIGRATIONS="$(find ../migrations -name '*.up.sql' -exec basename {} \; \
  | awk -F_ '{print $1 + 0}' | sort -n | paste -sd, -)"
APPLIED_MIGRATIONS="$(docker exec "$DB_CONTAINER" \
  psql -X -U postgres -d druvia -Atc \
  "SELECT coalesce(string_agg(version::text, ',' ORDER BY version), '')
     FROM druvia_schema_versions;")"
test "$APPLIED_MIGRATIONS" = "$EXPECTED_MIGRATIONS"

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  up -d --no-deps --force-recreate api

API_READY=0
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:3001/health > /dev/null 2>&1; then
    API_READY=1
    break
  fi
  sleep 2
done
test "$API_READY" = "1"

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  up -d --no-deps --force-recreate admin deno
```

脚本中的 metadata replace/consistency、目标数据库 SQL/migration readiness 和 API liveness 是切换门禁；不能只根据容器 `running` 判定成功。任一步失败都不要继续启动后续服务，将 `.env` 恢复为原目标并重新执行完整流程。执行 migration 前还必须确认宿主连接端口：普通库为 `5532`，PostGIS 端口从容器实际映射读取。

</details>

#### 停止 PostGIS 并保留数据

先确认 `.env` 与运行中的 API/Hasura 均已切回 `postgres`，再执行：

```bash
set -euo pipefail
cd /Users/cloudio/Developer/nodejs/Druvia/docker

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  config --format json \
  | jq -e '.services.api.environment.DB_HOST == "postgres"
      and (.services.hasura.environment.HASURA_GRAPHQL_DATABASE_URL
        | contains("@postgres:5432/druvia"))' > /dev/null

test "$(docker inspect druvia-api --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^DB_HOST=//p')" = "postgres"
test "$(docker inspect druvia-hasura --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's#^HASURA_GRAPHQL_DATABASE_URL=.*@\([^:]*\):5432/druvia$#\1#p')" = "postgres"

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  stop postgres-postgis

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  rm -f postgres-postgis

test -d postgres_postgis_data
```

不要为清理 Druvia 服务使用 `--remove-orphans`，本机可能存在共享 Compose project 名下的其他数据库容器。禁止使用 `down -v`、`rm -v` 或手工删除任一数据库目录。

### 本地单库切换为 PostGIS

以下是原地替换数据库镜像的单库流程，适用于需要模拟生产单库 PostGIS 的场景；日常本地开发优先使用上述双库模式。命令只替换 `druvia-postgres` 容器，继续使用 `docker/postgres_data` bind mount。开始前先进入 Docker 目录，并确认实际挂载符合预期：

```bash
cd /Users/cloudio/Developer/nodejs/Druvia/docker

docker inspect druvia-postgres \
  --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

输出必须包含当前仓库的 `docker/postgres_data -> /var/lib/postgresql/data`。随后在仓库外创建并验证切换前备份：

```bash
BACKUP_DIR="$HOME/backups/druvia"
BACKUP="$BACKUP_DIR/druvia_before_postgis_$(date +%F_%H%M%S).dump"

mkdir -p "$BACKUP_DIR"

docker exec druvia-postgres \
  pg_dump -U postgres -d druvia \
  -Fc --no-owner --no-privileges \
  > "$BACKUP"

test -s "$BACKUP"
docker exec -i druvia-postgres pg_restore -l < "$BACKUP" > /dev/null
```

拉取镜像，停止可能写数据库的服务，只重建 PostgreSQL：

```bash
docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  pull postgres

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  stop api admin hasura deno

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  up -d postgres

until docker exec druvia-postgres \
  pg_isready -U postgres -d druvia; do
  sleep 2
done
```

数据库健康后，为已有数据库显式启用扩展：

```bash
docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  --profile postgis-tools \
  run --rm postgis-enable

docker exec druvia-postgres \
  psql -U postgres -d druvia \
  -c "SELECT extname, extversion
      FROM pg_extension
      WHERE extname LIKE 'postgis%';"
```

最后恢复应用服务并检查状态：

```bash
docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  up -d api admin hasura deno

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  ps
```

PostGIS 仍启用时，后续本地 Compose 命令必须保持主文件在前、overlay 在后。

### 本地单库仅下架容器并保留数据

该流程用于删除 PostGIS 容器、暂时停止数据库，但保留 `docker/postgres_data`，以后仍以 PostGIS 镜像重新上架。先停止写入服务，再停止并移除 PostgreSQL 容器：

```bash
cd /Users/cloudio/Developer/nodejs/Druvia/docker

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  stop api admin hasura deno postgres

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  rm -f postgres

test -d postgres_data
du -sh postgres_data
```

重新上架时仍须携带 overlay：

```bash
docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  up -d postgres
```

`rm -f postgres` 只删除容器，不删除 bind mount。禁止使用 `docker compose down -v`、`docker compose rm -v postgres`、`docker volume prune` 或手工删除 `postgres_data`。

### Release 部署示例

Release 环境使用相同 overlay，首次切换时只重建 `postgres`，确认健康后再显式启用扩展：

```bash
cd /opt/apps/druvia/docker

docker compose \
  --env-file .env.prod \
  --env-file .env.release \
  -f docker-compose.release.yml \
  -f docker-compose.postgis.yml \
  up -d postgres

docker compose \
  --env-file .env.prod \
  --env-file .env.release \
  -f docker-compose.release.yml \
  -f docker-compose.postgis.yml \
  --profile postgis-tools \
  run --rm postgis-enable
```

- 传统生产使用 `docker-compose.prod.yml`，其余参数和文件顺序不变；主 Compose 必须在前，PostGIS overlay 必须在后。
- 验证扩展与 Hasura 状态：

```bash
docker exec druvia-postgres \
  psql -U postgres -d druvia \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'postgis';"

docker exec druvia-hasura sh -lc '
curl -fsS -X POST http://localhost:8080/v1/metadata \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -d "{\"type\":\"reload_metadata\",\"args\":{\"reload_sources\":true,\"recreate_event_triggers\":true}}"
'
```

- PostGIS 仍启用或继续使用原数据目录期间，所有人工 `up`、数据库恢复和维护命令都必须同时传入主 Compose 与 `docker-compose.postgis.yml`。遗漏 overlay 后执行完整 `up -d` 可能按主文件中的 `postgres:17-alpine` 重建数据库容器。只有完成下述无依赖卸载，或把启用前备份恢复到新的普通 PostgreSQL 17 数据目录后，才能停止携带 override。
- 普通 OTA 仍只管理应用服务；PostGIS overlay 文件不会被 release manifest 替换。数据库镜像、PostGIS 扩展版本升级和回退必须在维护窗口人工执行，并分别验证备份、扩展版本、Hasura metadata 和应用查询。

### PostGIS 安全回退

不能把 PostGIS 镜像回退等同于普通容器镜像回退。`CREATE EXTENSION postgis` 会持久化数据库 catalog；空间列、索引、函数或视图一旦依赖扩展，普通 `postgres:17-alpine` 即使能够启动同一数据目录，也无法正常提供这些对象。

- 尚未创建任何 PostGIS 依赖对象时：停止应用写入并再次备份，然后先在事务中验证无外部依赖。该命令必须成功且最终回滚：

```bash
docker exec druvia-postgres \
  psql -X -U postgres -d druvia -v ON_ERROR_STOP=1 \
  -c 'BEGIN; DROP EXTENSION postgis; ROLLBACK;'
```

- 只有上述验证成功，才能在维护窗口执行不带 `CASCADE` 的 `DROP EXTENSION postgis`，确认扩展不存在后停止 PostgreSQL，再用不带 overlay 的主 Compose 切回普通 PostgreSQL 17 镜像。
- 已存在空间列、索引、函数、视图或数据时：不得执行 `DROP EXTENSION postgis CASCADE`，也不得让普通 PostgreSQL 镜像复用当前 `postgres_data`。应继续固定兼容的 PostGIS 镜像；若必须完全退出 PostGIS，则停止所有写入，把当前目录保留为隔离副本，创建新的空 PostgreSQL 17 数据目录，并恢复“启用 PostGIS 之前”的已验证备份。
- 启用 PostGIS 之后生成的完整备份通常包含扩展和空间对象，恢复目标也必须先具备兼容 PostGIS 库；它不能替代启用前备份作为普通 PostgreSQL 回退点。

本地确认事务测试成功后，安全切回普通 PostgreSQL 的最小命令如下。执行前仍须停止所有写入并重新备份：

```bash
docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  stop api admin hasura deno

docker exec druvia-postgres \
  psql -X -U postgres -d druvia -v ON_ERROR_STOP=1 \
  -c 'DROP EXTENSION postgis;'

docker exec druvia-postgres \
  psql -X -U postgres -d druvia -v ON_ERROR_STOP=1 \
  -c "SELECT extname FROM pg_extension WHERE extname LIKE 'postgis%';"

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.postgis.yml \
  stop postgres

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  up -d postgres

docker compose \
  --env-file .env \
  -f docker-compose.local.yml \
  up -d api admin hasura deno
```

扩展查询必须为空后才能省略 overlay。若还存在 `postgis_topology`、`postgis_raster` 等扩展，必须逐个确认没有外部依赖并按依赖顺序无 `CASCADE` 删除；任一删除失败都应停止切换。若已经存在空间数据或其他依赖，则不能执行以上复用原数据目录的流程，只能继续使用 PostGIS，或者把启用前备份恢复到新的普通 PostgreSQL 17 数据目录。

## 本地 Docker 恢复生产数据库

该流程用于把 `pg_dump` 生成的生产备份完整覆盖到本地 Docker 数据库，输入可以是纯 SQL、custom archive 或它们的 gzip 外层压缩。它会删除当前本地 `druvia` 数据库，只能在确认目标容器为 `druvia-postgres` 后执行；备份文件不得放入 Git 仓库。

当前本地容器契约：

- PostgreSQL 容器：`druvia-postgres`
- 数据库用户：`postgres`
- 数据库名称：`druvia`
- Compose 文件：`docker/docker-compose.local.yml`

以下流程假设备份由未带 `--create` 的 `pg_dump` 生成。若原命令使用了 `--create`，不要直接套用重建步骤，应先核对归档中的目标数据库名，避免创建或覆盖错误数据库。重建空库后恢复还要求 dump 未使用 `--clean`，或同时使用了 `--clean --if-exists`；仅使用 `--clean` 的纯 SQL 会因空库中的首条 `DROP` 失败而被 `ON_ERROR_STOP` 中止，推荐重新导出而不是关闭错误门禁。

### 0. 推荐的生产导出方式

用于导入本地或其他环境时，优先生成 PostgreSQL custom archive。该格式自带压缩，不需要额外 gzip；不要使用 `docker exec -t`、`pg_dump --clean` 或误导性的 `.sql.gz` 扩展名：

```bash
BACKUP_DIR="$HOME/backups/druvia"
BACKUP="$BACKUP_DIR/druvia_$(date +%F_%H%M%S).dump"

mkdir -p "$BACKUP_DIR"

docker exec druvia-postgres \
  pg_dump \
    -h localhost \
    -p 5432 \
    -U postgres \
    -d druvia \
    -Fc \
    --no-owner \
    --no-privileges \
  > "$BACKUP"

test -s "$BACKUP"
docker exec -i druvia-postgres pg_restore -l < "$BACKUP" > /dev/null
sha256sum "$BACKUP" > "$BACKUP.sha256"
```

- host shell 的 `>` 将归档直接写到宿主机 `BACKUP_DIR`，不是容器 `/tmp`。
- `-Fc` 已包含压缩和大对象，不需要再加 `-b` 或 gzip。
- 不指定 schema 时会包含业务 schema、`public` 和同库的 `hdb_catalog`。
- `--no-owner --no-privileges` 适用于导入本地、预发布或不同角色环境；RLS policies、表结构和 Hasura catalog 仍会导出。
- 若用途是同环境的严格灾难恢复，需要保留原 owner/ACL，则生成另一份不带 `--no-owner --no-privileges` 的归档，并同时备份所依赖的 PostgreSQL roles；不要把跨环境联调归档与灾难恢复归档混为一份。
- macOS 默认使用 `shasum -a 256 "$BACKUP" > "$BACKUP.sha256"` 替代 `sha256sum`。

### 1. 确认备份格式和 Hasura catalog

```bash
cd /Users/cloudio/Developer/nodejs/Druvia/docker
BACKUP="/生产备份的完整路径/production.sql.gz"

# 先以实际内容判断格式，不相信扩展名。
file "$BACKUP"

# gzip 文件：输出 PGDMP 表示内层是 custom archive，否则通常是纯 SQL。
gzip -dc "$BACKUP" | head -c 5

# 非 gzip 文件：输出 PGDMP 表示直接是 custom archive；以 -- 开头通常是纯 SQL。
head -c 5 "$BACKUP"
```

路径变量中不要写字面量 `~/...`，因为变量展开后 shell 不会再次展开波浪号。应使用 `BACKUP="$HOME/..."` 或完整绝对路径。文件名以 `.gz` 结尾不代表内容一定经过 gzip；`file` 显示 `Unicode text` / `ASCII text` 时应按未压缩纯 SQL 处理。

Hasura 默认与业务数据共用 `druvia` 数据库，其 tracking、relationships、permissions、actions 等 metadata 位于 `hdb_catalog`。恢复前确认备份是否包含该 schema：

```bash
# 纯 SQL gzip
gzip -dc "$BACKUP" | rg -m 1 'hdb_catalog'

# 未压缩纯 SQL
rg -m 1 'hdb_catalog' "$BACKUP"

# custom archive gzip
gzip -dc "$BACKUP" |
  docker exec -i druvia-postgres pg_restore -l |
  rg -m 1 'hdb_catalog'
```

没有匹配时，业务 schema 仍可恢复，但 Hasura metadata 不会随数据库恢复，后续必须通过已有 metadata 部署流程重新应用 `hasura/metadata`，不能只执行 reload。

### 2. 停止写入并重建本地数据库

```bash
cd /Users/cloudio/Developer/nodejs/Druvia/docker

# 可选：先把当前本地库备份到仓库外。
docker exec druvia-postgres \
  pg_dump -U postgres -d druvia -Fc \
  > /tmp/druvia-local-before-restore.dump

# 停止所有可能读写数据库的应用服务，保留 PostgreSQL 和 Redis 容器。
docker compose -f docker-compose.local.yml stop api admin hasura deno

docker exec druvia-postgres \
  dropdb -U postgres --if-exists --force druvia

docker exec druvia-postgres \
  createdb -U postgres -T template0 -O postgres druvia
```

### 3. 按备份格式恢复

未压缩纯 SQL：

```bash
docker exec -i druvia-postgres \
  psql -X -U postgres -d druvia -v ON_ERROR_STOP=1 \
  < "$BACKUP"
```

纯 SQL gzip：

```bash
gzip -dc "$BACKUP" |
  docker exec -i druvia-postgres \
    psql -X -U postgres -d druvia -v ON_ERROR_STOP=1
```

custom archive gzip（解压后以 `PGDMP` 开头）：

```bash
gzip -dc "$BACKUP" |
  docker exec -i druvia-postgres \
    pg_restore \
      -U postgres \
      -d druvia \
      --exit-on-error \
      --no-owner \
      --no-privileges
```

未压缩 custom archive（文件直接以 `PGDMP` 开头）：

```bash
docker exec -i druvia-postgres \
  pg_restore \
    -U postgres \
    -d druvia \
    --exit-on-error \
    --no-owner \
    --no-privileges \
  < "$BACKUP"
```

恢复命令必须成功退出后才能继续。不要通过移除 `ON_ERROR_STOP` 或 `--exit-on-error` 跳过失败对象；应先处理版本、扩展、owner 或 dump 范围不一致问题，再从重建数据库开始重试。

### 4. 清理旧缓存并启动服务

数据库已被整体替换，旧 Redis session/cache 可能引用不存在或已经变化的数据，因此本地演练需要清空 Redis：

```bash
docker exec druvia-redis redis-cli FLUSHALL

docker compose -f docker-compose.local.yml up -d
docker compose -f docker-compose.local.yml ps
```

若本地代码比生产备份更新，不要默认把“恢复成功”当作“数据库已符合当前代码版本”。先核对 migration 版本，再按目标联调基线决定是否执行未应用 migration；执行后该数据库不再是生产库的原样副本。

### 5. 主动刷新 Hasura metadata

当备份包含 `hdb_catalog` 时，Hasura 重启会读取恢复后的 catalog；仍应主动 reload source 和 metadata cache，并重建 event triggers：

```bash
# 等待 Hasura 真正开始接受请求，避免 compose up -d 后立即 reload 的启动竞态。
until docker exec druvia-hasura \
  curl -fsS http://localhost:8080/healthz > /dev/null; do
  sleep 2
done

docker exec druvia-hasura sh -lc '
curl -fsS -X POST http://localhost:8080/v1/metadata \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -d "{\"type\":\"reload_metadata\",\"args\":{\"reload_sources\":true,\"recreate_event_triggers\":true}}"
'
```

随后检查不一致 metadata：

```bash
docker exec druvia-hasura sh -lc '
curl -fsS -X POST http://localhost:8080/v1/metadata \
  -H "Content-Type: application/json" \
  -H "x-hasura-admin-secret: $HASURA_GRAPHQL_ADMIN_SECRET" \
  -d "{\"type\":\"get_inconsistent_metadata\",\"args\":{}}"
'
```

正常结果必须包含：

```json
{
  "is_consistent": true,
  "inconsistent_objects": []
}
```

最后执行基础检查：

```bash
docker exec druvia-postgres \
  psql -U postgres -d druvia -c '\dn'

curl -fsS http://localhost:3001/health
curl -fsS http://localhost:8180/healthz
```

PostgreSQL 备份不包含 `docker/storage_data` 的对象文件，也不包含 Redis 数据。需要验证 Storage 时必须单独、安全地同步对象目录；生产用户数据和备份不得提交到仓库或用于无访问控制的共享开发环境。

## SDK 发布

- SDK 包目录：
  - `cd /Users/cloudio/Developer/nodejs/Druvia/packages/sdk`
- 发版前最小验证：
  - `pnpm --filter @druvia/sdk build`
  - `pnpm test:sdk`
- 先检查当前版本与 npm 登录状态：
  - `npm pkg get version`
  - `npm whoami`
- 预发布版本如 `0.1.0-beta.3` 不能直接裸跑 `npm publish`：
  - npm 11 会要求显式指定 dist-tag
  - 发布到 beta 通道当前最新版本应使用 `npm publish --tag beta`
- 若 npm 账号开启 2FA：
  - `npm publish --tag beta --otp <一次性验证码>`
- 正式稳定版才使用默认 `latest`：
  - 先把 `packages/sdk/package.json` 改成不带 prerelease 后缀的版本，例如 `0.1.0`
  - 再执行 `npm publish`
- 发布后验证 dist-tag：
  - `npm dist-tag ls @druvia/sdk`
- 若需要把某个 beta 版本显式切成默认 `latest`：
  - 这不是常规 prerelease 发布步骤，默认不建议使用
  - 执行前应明确接受 `npm i @druvia/sdk` 将默认安装该 beta 版本
  - 示例：
  - `npm dist-tag add @druvia/sdk@0.1.0-beta.3 latest`

### 本地 tarball 联调

- 适用于 Druvia SDK 尚未发布到 npm，但需要在独立的 taro-app 根项目和 H5 子项目中验证当前源码的场景。
- 打包前仍需从 Druvia 根目录执行最小验证：
  - `pnpm test:sdk`
  - `pnpm --filter @druvia/sdk build`
- 确认 `packages/sdk/package.json` 已使用一个未发布的测试版本；例如当前下一版为 `0.1.0-beta.5`。
- 进入 SDK 目录并检查、生成 tarball：
  - `cd /Users/cloudio/Developer/nodejs/Druvia/packages/sdk`
  - `npm pack --dry-run`
  - `npm pack`
- scoped package `@druvia/sdk@0.1.0-beta.5` 的默认产物名为：
  - `/Users/cloudio/Developer/nodejs/Druvia/packages/sdk/druvia-sdk-0.1.0-beta.5.tgz`
- Taro 根项目使用独立 `node_modules`，需要单独临时安装：

  ```bash
  cd /Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app
  npm install --no-save --package-lock=false \
    /Users/cloudio/Developer/nodejs/Druvia/packages/sdk/druvia-sdk-0.1.0-beta.5.tgz \
    --legacy-peer-deps
  ```

- H5 子项目也使用独立 `node_modules`，需要再次安装：

  ```bash
  cd /Users/cloudio/Developer/RN/TestRn-Cursor/taro/taro-app/h5
  npm install --no-save --package-lock=false \
    /Users/cloudio/Developer/nodejs/Druvia/packages/sdk/druvia-sdk-0.1.0-beta.5.tgz
  ```

- 安装后分别在 Taro 根项目和 `h5/` 中执行 `npm ls @druvia/sdk`，确认实际解析到 tarball 中的版本。
- `--no-save --package-lock=false` 只替换本地 `node_modules`，不应把本机绝对 tarball 路径写入应用的 `package.json` 或 `package-lock.json`；安装后仍应检查应用仓库 `git status`。
- tarball 联调仅用于本地验证，不是可提交或生产分发方式。验证通过并发布 npm beta 后，应在 Taro 和 H5 中分别安装精确的 registry 版本，并提交各自的 `package.json` 与 lockfile。
- 同一版本重新打包前必须确认内容与版本语义；对外发布后禁止用相同版本号覆盖已有 npm 包。

- 常见失败优先排查：
  - `You must specify a tag using --tag when publishing a prerelease version.`
  - 结论：当前版本是 prerelease，改用 `npm publish --tag beta`
  - `404 Scope not found`
  - 结论：当前账号缺少 `@druvia` scope 创建或发布权限

## 应用侧接 beta SDK

- beta 持续期内，应用侧不要把“是否跟进最新 beta”混同为“是否跟进默认 latest”
- taro-app 若当前使用 `pnpm-lock.yaml`，不要混用 `npm install`：
  - 优先使用 `pnpm add` / `pnpm up`
- 当前已知 taro-app 迁移仓库实际使用 `npm + package-lock.json`
- 该仓库在升级与 SDK 无关的依赖树时，可能触发既有 RN/Taro peer 冲突：
  - `@tarojs/components-rn@4.0.12` 要求 `@react-native-picker/picker@2.6.1`
  - `@ant-design/react-native@5.0.0` 要求 `@react-native-picker/picker@^1.9.10`
  - 因此仅升级 `@druvia/sdk` 时，允许使用 `--legacy-peer-deps` 跳过这类历史 peer 校验
- 对 taro-app / H5 这类迁移项目，推荐分两种模式：
  - 联调分支跟进 beta 通道最新版本：
  - `pnpm add @druvia/sdk@beta`
  - 后续更新：
  - `pnpm up @druvia/sdk@beta`
  - 主分支或待发布版本锁定具体 beta 版本：
  - `pnpm add @druvia/sdk@0.1.0-beta.3`
  - 后续人工切到下一版：
  - `pnpm up @druvia/sdk@0.1.0-beta.4`
- 若使用 npm 而不是 pnpm：
  - 跟进 beta 通道：`npm install @druvia/sdk@beta`
  - 锁定具体版本：`npm install @druvia/sdk@0.1.0-beta.3`
  - 若命中既有 peer 冲突，但本次只是在升级 SDK：
  - `npm install @druvia/sdk@beta --legacy-peer-deps`
  - 或锁定具体版本：
  - `npm install @druvia/sdk@0.1.0-beta.3 --legacy-peer-deps`
- 若应用和 Druvia 仓库本地联调：
  - 优先使用 workspace 或 link，而不是反复发 npm 包
  - 现有迁移文档示例为 `pnpm add @druvia/sdk@workspace:*`
- 应用侧升级前，先检查“当前声明版本 / 当前已安装版本 / beta 通道目标版本”：
  - 当前 `package.json` 声明：
  - `npm pkg get dependencies.@druvia/sdk`
  - 当前本地已安装版本：
  - `npm ls @druvia/sdk`
  - 当前 beta 通道指向版本：
  - `npm view @druvia/sdk@beta version`
  - 当前所有 dist-tag：
  - `npm dist-tag ls @druvia/sdk`
- 若 taro-app 实际用 `pnpm` 管理依赖，可用对应命令：
  - 当前本地已安装版本：
  - `pnpm list @druvia/sdk`
  - 升级到 beta 通道当前最新版本：
  - `pnpm up @druvia/sdk@beta`
- 实际安装行为要区分：
  - `package.json` 写 `@druvia/sdk: beta` 代表“跟 beta 通道”
  - 但 lockfile 仍会锁住当前解析到的具体版本，不会每次安装都自动漂到最新
  - 需要显式执行 `pnpm up @druvia/sdk@beta` 或 `npm install @druvia/sdk@beta` 才会真正更新到新 beta
- `--legacy-peer-deps` 只适合“本次仅变更 SDK、且已知冲突来自项目既有 RN/Taro 依赖”的场景：
  - 它不会修复根因
  - 若后续要调整 React Native / Taro 相关依赖，仍应回到正常 peer 约束下处理
- 推荐默认约定：
  - SDK 发布侧持续维护 `beta` dist-tag 指向最新 beta
  - 应用侧默认使用 `@beta` 安装或升级
  - 不建议把 beta 强行切到默认 `latest`，否则未显式声明 beta 通道的应用也可能被动吃到预发布版本

## taro-app 生产基线与后续升级

### 冻结上线依赖

- 建立一份可审计的版本矩阵：
  - taro-app/H5/小程序客户端版本或 commit
  - `@druvia/sdk` 精确版本
  - Druvia release/tag 与四个镜像 digest
  - migration 起止版本
  - Registry 和 release manifest URL
- 盘点 taro-app 实际使用的业务表、owner column、匿名/认证权限、Project Auth provider、RPC、Functions、Realtime subscription 和 Storage bucket preset。
- 未被 taro-app 使用的 Phase B-D 能力不进入上线阻塞清单。

### 真实应用验收

- 使用真实 taro-app 凭证和业务数据形态验证：
  - 登录、silent login、session 恢复、refresh 和 logout
  - GraphQL 查询/写入、匿名边界、同项目跨用户隔离和跨项目拒绝
  - Realtime token exchange、首次订阅、断线重连、身份变化和停止订阅
  - H5/浏览器直连 Storage，以及小程序实际使用的 Edge Function/runtime-native 上传路径
  - taro-app 实际调用的 RPC 和 Functions，不使用 Platform Session 或客户端 Hasura admin secret
- 只将真实失败、安全缺口和兼容阻塞回写 Druvia Core；不因上线窗口横向增加未使用的 provider、adapter 或平台服务。

### 预发布与 stable 发布

- 在与生产相同 Compose/release 结构的预发布环境执行：
  - 数据库和 Storage 备份
  - 当前生产 migration 到目标 migration 的升级
  - API/Admin/Worker/Updater 健康检查
  - taro-app 核心 smoke test
  - 镜像回滚和必要的数据库人工恢复演练
- migration `018 -> 020` 包含权限模式、迁移状态和 Storage owner/preset 变更；旧部署升级前必须重新核对当前数据库版本、manifest 范围和备份要求，不能只依据默认 workflow 输入。
- 正式生产只使用 `DRUVIA_UPDATE_CHANNEL=stable` 和通过上述验收的 manifest；镜像实际引用必须为 digest。
- updater 保持被动通知和人工 apply。Actions 完成、镜像推送或 release 创建都不是生产升级授权。
- 当前 production manifest 示例使用 GitHub `releases/latest/download`。release workflow 尚未将 beta/nightly 完整隔离为不会影响该入口的 prerelease 路径，因此隔离完成前不得让 beta/nightly 覆盖生产跟随的 latest Release。

### 上线后的升级节奏

- 紧急 patch：只包含安全、数据一致性、生产故障或 taro-app 兼容修复，执行定向回归后发布。
- 普通平台更新：按完整、可回滚的功能切片积累，在 taro-app 兼容回归通过后发布下一 stable，不按 commit 或 Phase 子任务更新生产。
- 后续 Phase 功能默认停留在开发/验证环境；未进入 stable manifest 前，不要求 taro-app 生产升级。
- 服务端变更至少兼容当前生产客户端和下一客户端版本。小程序新版本通过审核且完成迁移后，才能移除旧接口或旧字段。
- 数据库使用 expand-contract：先增加并双读/双写或保持兼容，再迁移客户端，最后在后续 stable 删除旧结构。
- 任何不可逆 migration 都必须先备份。应用镜像回滚成功时，仍需单独判断数据库是否需要人工恢复。

## Functions invoke 配置排查

如果在 Admin UI 更新函数时报 500，并带有：

- `column "invoke_auth_mode" of relation "druvia_functions" does not exist`

优先结论：

- 后端字段已接入
- 数据库缺少 `015_function_invoke_auth_mode` 迁移

先执行迁移，再重试页面保存。

## Edge Function Internal GraphQL 排查

如果新函数使用 `druvia.graphql()` 失败，优先检查：

- API 是否已注册 `/api/internal/functions/graphql`
- 函数 invoke 是否向 Worker 注入了 `internalToken`
- 若未显式注入 `apiBaseUrl`，确认 Deno Worker 进程已配置 `DRUVIA_API_URL`
- 函数代码是否仍在依赖 `DRUVIA_GRAPHQL_URL` / `HASURA_ADMIN_SECRET`
- Hasura admin secret 是否仅保留在 API 服务端，而不是项目函数 secrets 中

## 文档回填手册

发生下列情况后，记得同步文档：

- 权限模型变化：更新最近的模块 `AGENTS.md`；若形成长期决策，同时更新 `docs/agent/design-decisions.md`
- 长期架构决策变化：更新 `docs/agent/design-decisions.md`
- 新模块局部规则变化：更新对应子目录 `AGENTS.md`
- 完整设计或实施过程：新增 `docs/plans/YYYY-MM-DD-*.md`
