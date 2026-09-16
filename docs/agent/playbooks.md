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

## 项目成员授权与撤销

前置条件：目标数据库已应用 migration `022`，目标用户是 active 平台用户。平台 `admin` 本身不提供项目权限；必须由 workspace owner 或数据库当前 `super_admin` 通过 Admin“项目设置 -> 项目成员”或正式成员 API 操作。

日常授权顺序：

1. 确认项目 ID、目标平台 user ID 和所需固定角色：`project_admin`、`database_admin` 或 `viewer`。
2. 先用 `GET /api/v1/projects/:projectId/member-candidates?q=...` 核对 active 用户，再用 `POST /api/v1/projects/:projectId/members` 创建关系；不要手写 `druvia_project_members`。
3. 用目标用户调用 `GET /api/v1/projects/:projectId/access`，核对服务端返回的 role/capabilities。
4. 验证本项目允许动作、另一个项目 403，以及成员管理、Trusted Backend Key、数据库凭证和项目删除等 owner-only 动作 403。
5. 检查 `druvia_activity_logs` 中对应的 `project_member.created`、`project_member.role_updated` 或 `project_member.removed` 记录。

撤销使用 `DELETE /api/v1/projects/:projectId/members/:userId`。用户被停用后访问会立即失效，但 owner 仍可移除其成员关系。紧急恢复时先确认 workspace owner/super_admin 仍为 active，再通过成员 API 恢复；不得通过修改 JWT role 或直接开放 Hasura admin 权限绕过。`022 down` 前成员表必须为空，生产回滚默认保留 migration 022。

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
- migration `018 -> 024` 包含权限模式、迁移状态、Storage owner/preset、Project Auth identity、项目成员授权、表级 Data Access provenance 和表删除 outbox；`024` 创建 PostgreSQL event trigger，执行迁移的数据库角色必须具备相应权限。旧部署升级前必须重新核对当前数据库版本、manifest 范围、数据库角色权限、`SECRETS_ENCRYPTION_KEY`、项目成员关系、受管策略/删除恢复状态和备份要求，不能只依据默认 workflow 输入。
- 正式生产只使用 `DRUVIA_UPDATE_CHANNEL=stable` 和通过上述验收的 manifest；镜像实际引用必须为 digest。
- updater 保持被动通知和人工 apply。Actions 完成、镜像推送或 release 创建都不是生产升级授权。
- 当前 production manifest 示例使用 GitHub `releases/latest/download`。release workflow 会校验 SemVer 后缀与 channel：预发布版本仅允许 `beta` 或 `nightly` 首段及后续纯数字标识，并标记为 GitHub prerelease；不得绕过 workflow 手工把非 stable Release 标记为 latest。

### 上线后的升级节奏

- 紧急 patch：只包含安全、数据一致性、生产故障或 taro-app 兼容修复，执行定向回归后发布。
- 普通平台更新：按完整、可回滚的功能切片积累，在 taro-app 兼容回归通过后发布下一 stable，不按 commit 或 Phase 子任务更新生产。
- 后续 Phase 功能默认停留在开发/验证环境；未进入 stable manifest 前，不要求 taro-app 生产升级。
- 服务端变更至少兼容当前生产客户端和下一客户端版本。小程序新版本通过审核且完成迁移后，才能移除旧接口或旧字段。
- 数据库使用 expand-contract：先增加并双读/双写或保持兼容，再迁移客户端，最后在后续 stable 删除旧结构。
- 任何不可逆 migration 都必须先备份。应用镜像回滚成功时，仍需单独判断数据库是否需要人工恢复。

## 表级 Data Access 接管与结构刷新

前置条件：目标平台数据库已应用 migration `023`、`024`，API 与 Admin 来自同一版本，Hasura 使用
v2.48 兼容 Metadata API。OTA 只安装平台 migration 和代码，不会自动接管或刷新项目业务表。

先确认数据库和 Hasura 状态：

```bash
DB_HOST=127.0.0.1 DB_PORT=<active-port> pnpm migrate status

curl -sS \
  -H "x-hasura-admin-secret: $HASURA_ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -d '{"type":"get_inconsistent_metadata","args":{}}' \
  "$HASURA_ENDPOINT/v1/metadata"
```

管理入口位于项目“数据访问”总览和数据表详情：

- `managed`：可普通保存；保存必须携带服务端返回的 baseline revision 和新 operation ID。
- `adoption_required`：已有受支持 scoped permission 但没有 provenance。先预览并核对 row scope、
  owner preset 和列 grants，再输入项目别名确认接管；adoption 不写 Hasura。
- `refresh_required`：metadata 仍等于受管基线，但数据库列能力已变化。新增列默认不选；仅勾选
  业务确实需要的 select/insert/update 字段后确认刷新。若 owner 字段被删除，刷新预览会安全关闭
  受影响的 owner 操作；若 owner insert 字段变为 generated/identity always，只关闭 insert。刷新中
  只能保留原 owner 或确认收紧，不能更换 owner，也不能把原 `owner/none` 放宽为 `all`。需要更换
  owner 时先完成刷新，再在 managed 状态通过普通保存设置。
- `custom`：规则与受管基线不一致或结构不受支持，只读处理；不得用 reconcile 覆盖。
- `recovery_required`：停止该项目其他 Data Access、DDL、Realtime 和删除操作，只使用页面恢复
  入口。持久状态仍为 `applying/recovering` 但已超过 writer deadline 与 5 秒 drain window 时，
  页面也会显示恢复入口；窗口结束前不要绕过 409 强制重试。
  历史异常记录若处于 `applying/recovering` 且没有 deadline，在 started/updated 后超过 35 秒才作为
  orphan 暴露恢复入口；recover API 也强制同一时间门禁，窗口内直接调用仍返回 in-progress。缺少
  started/updated 的记录失败关闭，不能人工修改 operation 状态绕过。

列删除或转为 generated/identity 后，Hasura 可能因旧 permission 引用失效列而显示 inconsistent。
Druvia reconcile 会用 v2 export 的 `resource_version` 做 CAS，并仅替换目标表当前项目 scoped
permissions；不得人工执行 `drop_inconsistent_metadata`，该命令会清理其他无关对象。直接通过
Hasura Console/admin-secret 修改 scoped permission 不受 Druvia 锁保护，adoption、apply、reconcile
和 recover 期间必须保持运维静默窗口。

操作完成后必须复核：

1. 表状态回到 `managed`，active operation 为空，baseline revision 按预期增加。
2. 新增列只出现在明确勾选的 operation；owner column 仍由 preset 写入，客户端写列不包含它。
3. generated/identity always 不在 insert/update permission。
4. legacy、其他项目 role 和外部 role 保持不变。
5. `get_inconsistent_metadata` 返回 `is_consistent: true`。

若恢复后 operation 为 `failed`，表示 source 已验证恢复，可重新 preview；若仍为
`recovery_required`，保留现场，不删除 operation/baseline，不执行 migration 023 down。生产使用过
migration 023 后只做前向修复。

表删除若在 PostgreSQL 已提交后无法 untrack Hasura，会保留
`druvia_table_deletion_outbox` pending 记录并阻断同 scope 管理写入，不影响无关项目。API 启动时
立即恢复，运行期间每 30 秒继续重试；无需重启服务。每次恢复先确认 PostgreSQL 中精确同名 relation
仍不存在，再通过带 30 秒超时的 v2 metadata export 精确判断默认 source 中的 schema/table 是否仍
存在；不能根据 untrack 错误文字推断已删除。migration `024` 的 event trigger 会在 pending 生命周期
内保留同名 relation：所有数据库连接尝试创建或重命名为该名称都会以 SQLSTATE `55006` 失败。不要
禁用该 trigger；看到此错误时应停止同 scope DDL，先查日志中的
`operationId/schemaName/tableName` 和 Hasura 可用性，
再等待自动收敛并确认：

```sql
SELECT operation_id, lock_scope, schema_name, table_name, attempts, last_error, updated_at
FROM druvia_table_deletion_outbox
ORDER BY created_at;
```

不要手工删除 outbox 或重复创建同名表。确认 Hasura 已无该表且 outbox 为空后，管理写入才会恢复。
`024 down` 只允许 outbox 为空；生产启用后仍优先采用新编号前向修复。

页面只有在 recover 返回终结的 `failed` 状态时提示恢复完成。若恢复接口返回
`DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED`，页面会重新读取持久状态并保留恢复弹窗；这不是成功，
不得继续受 gate 阻断的管理操作。

Hasura 请求发生 transport/timeout，或回退到非原子 `bulk` 后返回错误时，前序 command 可能已经
生效。此时 Druvia 会保留 recovery gate，不会立即发送 source restore；等待 deadline/drain 后再从
页面恢复。不要因客户端收到 502/409 就手工删除 operation，也不要直接在 Hasura Console 覆盖。

普通保存请求若因断网、代理超时或页面刷新而没有得到确定响应，Admin 会为同一用户意图保留
operation ID 和当时提交的完整请求体。再次保存相同意图时必须原样重放，不能把新读取到的 baseline
revision 拼入旧请求；服务端只有在当前 baseline 仍指向该 operation 的完成 target 时才返回幂等成功。
若返回 `DATA_ACCESS_POLICY_STALE`，重新读取当前策略并由用户确认后使用新 operation ID 发起新操作。

stable release workflow 另有 `data-access-integration` 必需 job：它启动隔离 PostgreSQL 17 与 Hasura
v2.48、执行 `pnpm migrate up`，再运行
`tests/integration/data-access-generated-columns.test.ts`。该 job 失败时不得构建或推送 GHCR、自建
Registry 镜像，也不得手工绕过为 stable manifest 补发镜像。该真实集成同时包含 PostgreSQL 提交后
Hasura untrack 失败、untrack 已成功但 outbox 清理失败，以及 pending 期间另一数据库连接同名 relation
重建的故障注入；必须证明前两者恢复后 metadata 收敛且记录清除，重建冲突由 event trigger 以
SQLSTATE `55006` 阻断，outbox 清除后名称可再次使用。

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

## Apple Project Auth 开发与运维

### 启用前置条件

- 先执行 `pnpm migrate up`，并用 `pnpm migrate status` 确认当前版本至少为 `021`。
- 使用 `openssl rand -hex 32` 为 API 生成独立的 64 位十六进制 `SECRETS_ENCRYPTION_KEY`；local/prod/release 必须恢复同一部署原有 key，不能用 `JWT_SECRET` 替代。
- 已有部署切换该 key 前，必须迁移或通过管理界面重新保存所有 Auth provider client secret 与 Function Secrets。直接新增不同 key 并重启会使旧密文不可解密；完成重存前，对应登录和 Function 会暂时失败。
- 项目默认 Schema 必须已有 `users.id`；如存在 `users.provider_id`，该列必须允许 `NULL`。建议 email 允许 `NULL`。
- 在 Admin 认证页配置 Team ID、Key ID、主 Bundle ID、允许 audience 和 ES256 PKCS8 `.p8`。私钥只提交给 Druvia API，不进入应用、镜像、release manifest 或 Git。

### 应用集成契约

- 原生登录：`POST /api/v1/projects/:projectId/auth/apple/login`，请求包含 `authorizationCode`、`identityToken`、`rawNonce`，首次授权可附 `profile.givenName/familyName`。
- SDK：调用 `client.projectAuth.appleLogin(...)`；成功后沿用 Project Session 的 access/refresh、`refresh()` 和 `logout()`，应用不保存 Apple provider refresh token。
- 用户撤销：同项目 Apple Project Session 调用 `POST /api/v1/projects/:projectId/auth/apple/revoke`。暂时失败保留 `revoke_pending`，管理员可在认证页重试。
- Server notification：`POST /api/v1/projects/:projectId/auth/apple/notifications`，不接受 Druvia JWT/API key，只接受 Apple 签名 payload。真实验收前必须配置公网 TLS 地址。
- 已启用 Project Account Self-Deletion 且 cleanup preflight 通过时，`account-deleted` 自动收敛到统一删除 operation；未启用项目继续进入既有待处理 lifecycle 兼容路径。
- 应用服务也可使用同项目 trusted backend key 调用 lifecycle event list/ack；必须显式授予 `project_auth_lifecycle:manage`，该高风险 scope 不在 trusted key 默认权限中，不能下发到客户端。
- 可重试错误：`PROVIDER_RATE_LIMITED`、`PROVIDER_UNAVAILABLE`。需要重新授权：`PROVIDER_REAUTH_REQUIRED`。配置/Schema 问题由管理员处理，不由客户端循环重试。

### Project Account Self-Deletion

#### 部署前置

1. 在启动包含该功能的新 API 前生成并备份两条独立密钥，不能复用 `JWT_SECRET`、`SECRETS_ENCRYPTION_KEY`、Hasura、Functions、Worker 或 Storage ticket secret：

```bash
openssl rand -hex 32 # ACCOUNT_DELETION_STATUS_SECRET
openssl rand -hex 32 # ACCOUNT_DELETION_FENCE_SECRET
```

2. 将密钥写入部署私有 `.env`，不要提交。两条值必须随数据库恢复保持稳定；丢失 status secret 会使既有状态凭证失效，丢失 fence secret 会破坏跨 generation 身份匹配。
3. 应用 migration `025` 后再启动 API。local Compose 已只读挂载 `/app/migrations`，可执行：

```bash
cd /Users/cloudio/Developer/nodejs/Druvia/docker
docker compose --env-file .env \
  -f docker-compose.local.yml \
  -f docker-compose.local.dual-db.yml \
  run --rm api node apps/api/dist/cli/migrate.js up
```

双库并行时，该命令跟随 `DRUVIA_LOCAL_DB_HOST`。另一库也必须在切换前显式设置 `DB_HOST=postgres` 或 `DB_HOST=postgres-postgis` 分别执行 migration；两套 migration 状态不会自动同步。生产/release 使用各自既有 Compose 命令，manifest migration ceiling 必须为 `25`。

4. 重建 API 以注入新环境变量，并确认执行器健康：

```bash
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:3001/health/account-deletion-executor
```

`accountDeletionExecutor=false`、overdue 或 `attentionRequiredOperations > 0` 都会使主健康检查或专用健康检查失败，并必须进入运维告警。关闭执行器的 API 不应承载生产流量。

#### 项目 Cleanup Hook

项目在自己的 schema 提供精确签名 `druvia_delete_project_user_data(text, uuid) RETURNS jsonb`。函数必须由 `druvia_projects.db_user` 拥有，使用 `SECURITY DEFINER` 和固定 `search_path = pg_catalog, <project_schema>, pg_temp`；`pg_temp` 必须显式置于末尾，并撤销 PUBLIC EXECUTE：

```sql
ALTER FUNCTION <project_schema>.druvia_delete_project_user_data(text, uuid)
  OWNER TO <project_db_user>;
ALTER FUNCTION <project_schema>.druvia_delete_project_user_data(text, uuid)
  SET search_path = pg_catalog, <project_schema>, pg_temp;
REVOKE ALL ON FUNCTION <project_schema>.druvia_delete_project_user_data(text, uuid)
  FROM PUBLIC;
```

函数 body、删除顺序、法定保留字段和设备 wipe ledger 由应用项目负责。必须以 `deletion_id` 建幂等 ledger，只删除传入 `project_user_id` 的业务数据，并在全部业务清理和待执行设备 wipe 状态已持久化后返回 `{"completed": true}`。不要通过调用真实用户数据来探测函数；Druvia 启用开关只做签名、owner、完整函数 ACL、固定 search path、高权限角色继承和跨 schema 写权限静态检查。除 owner 外不得向 PUBLIC 或任何其他角色授予 EXECUTE。正常执行会在同一 PostgreSQL statement 内复验 operation 持久 contract hash 与当前固定 search path 后调用函数；任一不符都会停止调用并进入 `attention_required`。

在 Admin 的 Project Auth 页面确认“业务清理：已就绪”，再启用“账户删除”。启用需要项目 `auth:manage` capability；存在未终结 operation 时不能禁用。

#### App 调用流程

1. 以当前 Apple Project Session 调用 `POST /api/v1/projects/:projectId/auth/account-deletions/intents`，请求体为空，携带 UUID `Idempotency-Key`。
2. App 在 Keychain 保存 `deletionId` 和 `statusToken`，将服务端 `reauthNonce` 的 SHA-256 交给 Apple AuthenticationServices。
3. 以同一 Project Session、`X-Druvia-Deletion-Token` 和 Apple reauth credential 调用 `POST .../:deletionId/confirm`。首次成功返回 `202` 后立即停止同步/Realtime 并清除当前设备 Session。
4. Access Token 失效、App 重启或响应丢失后，以 deletion token 调用 `GET .../:deletionId`。accepted/completed 的 confirm 重放也不需要再次提交 Apple credential。

客户端不得发送 user ID、identity ID、Apple subject、Platform Token、Trusted Backend Key 或 Hasura 凭证。status token 只能放在专用请求头，不得放入 URL、日志或遥测。

#### 失败与恢复

- transient Hook、Storage 或 Apple revoke 错误由 API 内执行器持久退避重试；API 重启后从 PostgreSQL lease 继续。
- contract drift 或超过 24 小时仍失败会进入 `attention_required` 并保留原失败 phase。先修复 Hook/Storage/配置并核对 operation，再由数据库管理员在维护窗口把该 operation 从 `attention_required` 原子改回 `processing`、设置 `next_attempt_at = NOW()`；不得改 project/user/schema/function/generation 或删除 fence。
- Apple `account-deleted` 在账户删除未启用或 Hook 未就绪时只会保留 `deletion_pending` 与待处理事件。lifecycle ack 不会直接删除业务用户；完成配置后再次 ack，服务端才会原子创建受管 operation/fence。
- 内建 project backup restore 会同时持有 Data Access 排他锁和 project-auth 项目锁，先写 runtime gate，再执行 `pg_restore`，对恢复后的 Hook 重新执行 owner/ACL/search path/跨 schema 权限安全预检，并使用恢复后摘要重放全部 `accepted / processing / attention_required / completed` fence 后开放项目。历史 operation 摘要可以不同于旧备份中的合法 Hook 版本。执行器 claim 会在同一项目锁内复验 runtime gate，不会与恢复并发修改同一项目。legacy schema-only backup 必须能唯一映射到同一 workspace/project，否则以 `BACKUP_SCOPE_MISMATCH` 拒绝。
- 直接运行外部 `pg_restore` 不会自动建立 runtime gate。涉及已启用账户删除的项目时，必须停掉 API/Admin/Hasura，改用经过审查的恢复流程，并在开放流量前重放 fence。
- 当前没有独立于主数据库的 deletion ledger。整库灾难恢复会同时回滚 `public` operation/fence，因此不能宣称可防止旧账户复活；生产启用前若要求该保证，必须先建设外部 append-only ledger 及 restore 前 import/reconcile 门禁。
- 已建立的 Hasura WebSocket 不能由本功能即时强制断开；App 主动断开和优先清除业务数据只缩短窗口，不构成服务端强制终止证明。

### Decommission 与恢复

1. 先禁用 Apple provider，停止新登录；禁用不会阻断已有 refresh 校验和 revoke。
2. 在认证页逐项处理 `revoke_pending` 和 `deletion_pending`，直到没有 active/pending identity、provider token 或 lifecycle event。
3. 再删除 provider、Project User 或项目。服务端删除门禁会拒绝跳过撤销的操作。
4. 数据库恢复必须同时恢复原 `SECRETS_ENCRYPTION_KEY`。key 丢失时停止 Apple 操作并从 secrets storage 恢复，不得重置密文。
5. 生产备份恢复到非生产环境后，先隔离外网 notification、禁用 Apple provider，并替换为非生产 Apple 配置。

Apple App transfer 的 transfer identifier、relay email 迁移不属于普通重复登录。发生 Team/App 转移时必须单独冻结窗口、按 Apple 转移流程迁移 identity；不得通过删除 identity 后重新登录制造新的 Project User。

## Project Device Wipe Mandates

### 部署与启用

1. 为 API 生成并备份两条彼此独立的密钥；不得复用 Auth、账户删除、Hasura、Functions、Worker、Storage 或彼此的密钥：

```bash
openssl rand -hex 32 # DEVICE_WIPE_BINDING_SECRET
openssl rand -hex 32 # DEVICE_WIPE_CREDENTIAL_SECRET
```

2. 将两条值写入部署私有 `.env`。同时保留原 `SECRETS_ENCRYPTION_KEY`；两条值必须彼此不同，并不得复用 JWT、Hasura Admin、Functions/Worker、Storage、Account Deletion、Updater、PostgreSQL 或 R2 凭据。Compose 会把这些已存在的部署凭据传给 API，仅用于启动时的密钥隔离校验；不要因此复制或生成第二套凭据。binding secret、credential secret 或 encryption key 任一丢失/替换，都会使已有 fingerprint、lookup credential、签名私钥或加密注册恢复材料不可恢复，不能通过重新启用开关修复。首次启用后，Druvia 会把两条 purpose-separated 不可逆验证标签写入项目 config；后续注册、重新启用或签名 key rotation 检测到不匹配时返回 `DEVICE_WIPE_SECRET_MISMATCH`，不得清空 config 标签或 core 记录强行重置。默认 `DEVICE_WIPE_HOOK_TIMEOUT_MS=5000`，恢复重放使用 `DEVICE_WIPE_RESTORE_HOOK_TIMEOUT_MS=30000`；二者分别限制在 1-60 秒和 1-300 秒，不应为了规避慢 Hook 无界增大。
3. 在启动新 API/Admin 前执行 migration `026`，并确认状态：

```bash
pnpm migrate up
pnpm migrate status
```

Docker 双库环境必须对当前 API/Hasura 实际连接的库执行；另一数据库不会自动同步。release/OTA manifest 的 migration ceiling 必须至少为 `27`。

4. 由应用仓库的前向 migration 在项目 schema 安装以下三个函数，保持普通 Hasura 客户端零 CRUD：

```text
druvia_register_device_wipe_binding(text, text, bigint) RETURNS jsonb
druvia_list_device_wipe_mandates(text, bigint) RETURNS jsonb
druvia_ack_device_wipe_mandate(text, bigint, uuid, jsonb) RETURNS jsonb
```

函数必须由项目 `db_user` 拥有，使用 `SECURITY DEFINER`、固定 `search_path=pg_catalog,<project_schema>,pg_temp`（`pg_temp` 必须显式置末尾），并撤销 PUBLIC 及非 owner EXECUTE。该 `db_user` 不能继承任何其他角色，也不能被任何非 superuser 角色直接或间接继承，并且不得拥有 `REPLICATION`；它不能在其他非系统 schema 拥有非 extension relation/column/sequence 权限或 CREATE，也不能执行其他 schema 中可直接调用的非 extension `SECURITY DEFINER` 函数。PostGIS 等由数据库管理员安装的 extension 自有对象不计为业务越权；`RETURNS trigger/event_trigger` 不可由普通 SQL 直接调用，也不计入 definer execute，但外部表 `TRIGGER` 权限仍会阻止启用。当前 MVP 因此只支持一个 `db_user` 隔离到一个项目 schema；共享该用户的多环境项目应保持设备擦除禁用，不能放宽检查绕过。业务 migration 必须在删除事务提交前创建 account/session mandate。
5. 重建 API/Admin 后，在项目“认证”页的“设备擦除指令”面板确认三个 Hook 已就绪，再启用。Apple provider 可以保持 disabled；本地 session-scope 联调不依赖 Apple。

启用前若返回 Hook security contract invalid，应由数据库管理员审计并撤销其他业务 schema 中授予该 `db_user` 或 `PUBLIC` 的权限，尤其是 `SECURITY DEFINER` 函数的 EXECUTE；不得在 Druvia 中增加白名单绕过。当前活动本地库已由 Taro migration 清除这类 PUBLIC EXECUTE，并通过跨项目 callable 检查；更换数据库或从旧备份恢复后必须重新执行 catalog 验证。

### 联调顺序

1. 使用受控 Project Session 注册 binding，持久保存返回的 `bindingHandle` 与 `bindingLookupToken`；客户端不得保存平台 Token、Trusted Backend Key 或原始 HMAC secret。
2. 使原 Project Session 过期或登出后，仅用 handle 和 `X-Druvia-Binding-Token` 查询 mandate，确认仍可获取相同签名 envelope。轮换后的 retired binding 只能领取此前已在 core 固化的 pending mandate，不再调用项目 Hook 发现新 obligation；新注册幂等键也不能恢复 retired credential。
3. 从公开 verification-keys endpoint 按 `keyID` 获取 Ed25519 JWK，对 canonical sorted-key JSON `{version,keyID,command}` 验签后执行本地擦除。
4. 提交 receipt；相同 receipt 重试应成功，不同 receipt 应返回冲突。用第二 Project User 和另一 binding 验证不可跨用户、跨项目获取。
5. 轮换 key 后确认新 mandate 使用新 active key，旧 key 仍公开为 verification-only；只有不再承载 pending mandate 时才可 retire。

禁用项目开关只停止新 binding 注册，不得阻断正常运行项目的既有设备查询或回执。sessionless query/receipt 与注册、配置写入和 key 变更都会争用 project schema restore 的同一项目锁；取得锁后必须在同一连接检查 runtime gate。只要状态仍为 `restoring` 或 `recovery_required`，全部写入/Hook 路径均返回 `503 PROJECT_RESTORE_IN_PROGRESS`，不得读取已物化 pending snapshot、调用 Hook 或写 core；修复并完成 replay、清除 gate 后再重试。普通 Hook 超时返回可重试的 `503 DEVICE_WIPE_HOOK_TIMEOUT`；恢复 Hook 超时会保留 gate 并标记 `DEVICE_WIPE_RESTORE_TIMEOUT`，应修复 Hook 性能后重新执行受控恢复，不能人工删除 gate。查询按 IP、project+IP、handle digest+IP 三层限流；随机更换 handle 仍受项目级预算约束。注册和查询限流使用原子 Redis Lua 计数并在 TTL 缺失时同语句修复，避免分步 `INCR`/`EXPIRE` 形成永久锁定；Redis 不可用时返回 `503 DEVICE_WIPE_RATE_LIMIT_UNAVAILABLE`，不得把此端点改成 fail open。原始 binding identity、binding handle、lookup token、Project User ID、私钥和 receipt 内容不得进入日志、Redis key 或工单；Project User ID 只以 encryption key 加密后保存为注册恢复材料。内置 Nginx 和 API 会把所有 binding 子路径以及任意包含 handle 的 URL（包括 query、命名空间外路径、非法转义、多层编码、重复斜杠和错误路径）统一显示为 `[REDACTED]`；API 对普通请求也只记录 path，不记录 query string。API 默认 404 不回显 URL；内置 Nginx 日志不记录 referer，且全局只保留 `crit` error，敏感 location 进一步关闭 error log，避免畸形请求、query-only handle 或 upstream 故障回显原 URI。Nginx 常规诊断使用脱敏 access log 的状态码、API 结构化日志、容器健康检查和指标，不得为恢复 `warn` error log 而重新扩大凭据日志面。生产若在 Druvia Nginx 前使用 CDN、Ingress 或负载均衡器，必须为 `/device-wipe/bindings/<handle>` 及其全部变体配置同等路径脱敏或关闭访问/error 日志，并通过编码/错误路径、伪造 query、Referer 和 upstream failure 的请求检查最外层日志。

内置 Nginx 会覆盖公网请求自带的 `X-Forwarded-For`，只把 `$remote_addr` 传给 Fastify。若 Nginx 前还有受信 CDN/Ingress，先在最外层或 Druvia Nginx 依据固定 CIDR 配置 real-IP，使 `$remote_addr` 是经过验证的客户端地址；不要恢复 `$proxy_add_x_forwarded_for`，否则 sessionless 三层限流可被伪造 header 绕过。
production/release Compose 的 API 端口默认只发布到宿主机 `127.0.0.1:3001`，供本机诊断使用；公网和局域网客户端必须使用 Nginx origin。若部署平台要求外部负载均衡器直接连接 API，应改为受控私网网络并同步实现可信代理 CIDR、敏感日志与限流验收，不能把该 loopback 绑定简单改回 `0.0.0.0`。

### 恢复与 Decommission

- project schema 恢复后，已 materialize/acknowledged 的 Druvia core 快照仍是去重围栏；在同一 runtime gate 和项目锁中逐一复验 binding 保存的三个 Hook 合同。先按不可变的 `binding_identity_hmac`、数值 `binding_revision`、`binding_id` 排序，解密 Project User replay material 并幂等重放全部 register Hook；再重放账户删除 fence，最后把全部 acknowledged receipt 幂等回放到 acknowledge Hook，之后才能开放设备查询。注册材料解密、合同或 register Hook 失败保留 `DEVICE_WIPE_BINDING_REPLAY_REQUIRED`；receipt 非法或 acknowledge Hook 失败保留 `DEVICE_WIPE_RECEIPT_REPLAY_REQUIRED`。不得按时间戳猜测 revision 顺序或人工删除 gate 绕过。
- 整库恢复必须同时恢复 migration `026` 四张 core 表及三条稳定 secret。仅恢复项目 schema、没有 core 快照时不能宣称可抑制已经确认的历史 mandate。
- 项目删除和管理 API 的独立数据库用户删除都会持有 project-auth 项目锁，并在 `REASSIGN OWNED`、`DROP OWNED`、`DROP ROLE`、schema 或 Storage 副作用前检查 binding/mandate，以 `409 DEVICE_WIPE_DECOMMISSION_REQUIRED` 阻断。不得用“先删除数据库用户”规避检查，否则三个 Hook 的 owner 与 restore 能力会被永久破坏。当前没有自动 decommission；不得直接删除 core 行绕过恢复围栏。项目永久下线流程需要独立审查、确认所有设备已 ack 后再建设受控清理能力。
- migration `026 down` 只允许 config、key、binding、mandate 全部为空；生产启用后采用新编号前向修复。

## Data Access v2 授权投影本地启用

本流程只负责 Druvia 平台 migration 和受管 Hasura metadata。应用业务 view 及其 DDL 仍由应用仓库 migration 维护；不要把应用 SQL 复制进 Druvia Core migration。

1. 确认 API 与 Hasura 当前连接的数据库。在双库环境中分别检查 `DB_HOST`，不要误把 migration 应用到备用普通 PostgreSQL。
2. 备份当前数据库和 Hasura metadata，再将平台数据库升级到 migration `027`：

```bash
docker exec druvia-api node apps/api/dist/cli/migrate.js status
docker exec druvia-api node apps/api/dist/cli/migrate.js up
```

3. 由应用仓库在同一活动数据库应用投影 view migration。view 必须属于当前项目 schema，由项目 `db_user` 拥有，启用 `security_barrier`、禁用 `security_invoker`，撤销 PUBLIC 表级和列级 privilege，并保证合同 key 无重复记录。view 及其同 schema helper view 的全部递归非系统 relation、inheritance/partition descendant 也必须留在该项目 schema；不能读取 dev/test 等其他环境 schema，当前也不能依赖项目或 extension function，包括 custom operator 的 implementation function。Druvia 会将依赖闭包，以及 helper view/materialized view 的定义、owner、完整 options、表级/列级 PUBLIC ACL 和输出列纳入 digest；定义摘要会保留 SQL 字面量内部空白，后续改写 helper、挂载跨 schema partition 或替换 operator implementation 会触发 `dependency_invalid`。
4. 检查机器合同：顶层只允许 `contractVersion`、`policyVersion`、`view`、`relationships`；必须为 `contractVersion: 1`、`policyVersion: 2`，不得携带 schema、说明字段或任意 Hasura JSON。每条 mapping 必须完整覆盖 view key，且 `ownerColumn` 映射到 `actorColumn`。
5. 打开项目“设置 -> 数据访问”，在“授权投影”区域导入 JSON。先执行预检，核对目标表、owner/allow column 和写权限保持不变，再输入项目别名应用。apply 会对预检时的完整 Hasura `resource_version` 执行 CAS；期间任何项目的 metadata 发生变化都必须重新预检，不会用旧完整 metadata 覆盖新变更。不要直接修改 Hasura metadata；同名关系必须是唯一且完整 `using` 一致的 object relationship。若任一已受管表显示“结构待同步”，先在该表执行单表 reconcile；v2 reconcile 只更新列能力与收缩后的 grants，保持 policy/constraint/dependency 不变，并在 preview、apply 接纳、metadata 写入前及 baseline 提交前复验依赖。服务端会拒绝任何扩大 grants 的请求，新增列不会自动授权，完成后才能重新执行项目投影预检。
6. timeout、transport 或 5xx 等未知 metadata 写结果进入恢复状态后，必须等待 writer deadline 加 drain window；不能通过立即点击恢复与迟到的 Hasura 写入竞争。
7. 若状态为“授权依赖异常”，使用“安全关闭”入口并输入项目别名。Druvia 会在项目锁内只允许最新成功 apply 的批次进入恢复；成功 apply 标记在 fail-closed 后仍保留，历史 operation 不能因此重新获得恢复资格。已成功批次即使当前 metadata 恰好回到预检时的旧 source，也会按漂移失败关闭，不能按“未应用”恢复 owner-only。活动状态不会被后续 failed、superseded 或未应用 preview 遮蔽；若尚有 `preview_ready`，恢复会在同一事务中先将其 supersede，再 claim 成功批次，claim 失败则保留原 preview。依赖仍漂移或无法证明完整 target 时，关闭合同内全部来源表的 authenticated select。修复应用 view/关系合同后重新导入完整合同预检，不能逐表退回 owner-only。
8. 验收 query、cross-user、allow=false/missing projection、relationship traversal 和 Realtime 使用同一 select 结果。不可读候选如需继续写入，mutation 只请求 `affected_rows`；Hasura 2.48 的 `returning`/`insert_one` 是本次写入回显，不受 select 行过滤抑制，不得用作读取授权证明。
9. 首次发布 migration `027` 前，先运行 GitHub Actions 的 `Updater Bootstrap Release`：`version` 必须是高于 `base_version` 的新稳定 SemVer，`base_version` 必须是当前部署产品版本，`migration_version` 必须与活动数据库当前版本精确相等且小于 `27`。workflow 会先下载 `v<base_version>` 的双 Registry manifest 与 Compose，校验版本、migration、Compose SHA、repository/tag/digest，并在登录 Registry/推送镜像前运行 PostgreSQL 17 rollback-gate 集成门禁；Registry tag 只用于确认没有漂移，应用 digest 不从可变 tag 重新推导。workflow 只构建 updater，生成 `required=false`、`from=to`、`minUpdaterVersion=0.1.0` 的双 Registry manifest，上传旧 release 的原 Compose，并以 `make_latest=false` 发布。bootstrap 会占用一个新的产品版本，但不会改变全局 stable latest；后续包含 migration `027` 的完整 stable release 必须再使用更高版本。
10. 在目标主机先确认 `.env.release` 的 `DRUVIA_VERSION` 等于 `base_version`，并用 migration status 确认数据库恰为输入版本。临时将 `DRUVIA_RELEASE_MANIFEST_URL` 指向 bootstrap 的显式版本资产，例如 `https://github.com/cloudiowoo/druvia/releases/download/v<bootstrap-version>/release-manifest.json`；自建 Registry 使用同 tag 下的 `release-manifest.cn.json`。不得将其他客户端或全局 `releases/latest/download` 指向 bootstrap。随后在现有 updater `0.1.0` 界面执行检查、下载和应用；服务可能按 Compose 编排重启，但 API/Admin/Worker digest 与 Compose 必须保持 base release 原值，只有 updater digest 变化。完成后从镜像内读取不可由 Compose 覆盖的能力版本：

```bash
docker exec druvia-updater node -e \
  "import('/app/apps/updater/dist/config.js').then(({CURRENT_UPDATER_VERSION}) => console.log(CURRENT_UPDATER_VERSION))"
```

输出必须为 `0.2.0`。未完成 bootstrap 的 updater `0.1.0` 会因后续 manifest 的 `minUpdaterVersion` 门禁拒绝 migration `027` release；不得通过环境变量伪造版本或降低 manifest 要求绕过。完整 stable release 成为 latest 后，将客户端 manifest URL 恢复到常规 stable 地址。
若状态停在 `finalizing`，新版 updater 会在轮询时查询具名 finalizer：容器仍运行则等待，Docker 暂不可用则保持原状态；确认容器不存在/停止后会显示“核心版本已更新，但 updater finalizer 未完成”。这个状态不代表 bootstrap 能力验收成功，必须按上面的容器内版本检查确认运行实例已经是 `0.2.0`；未通过时先排查并修复 updater 自更新，再继续 migration `027` 发布。
11. 完整 stable 发布时确认 manifest migration ceiling 为 `27`、`minUpdaterVersion >= 0.2.0`；manifest 生成器会严格解析并拒绝更低或非 SemVer 的最低 updater 版本，不能通过手工 workflow 参数降低门禁。本版 API 启动要求活动数据库 migration 正好处于其支持的 floor/ceiling `27`。migration `027` 及后续版本执行文件回滚时，updater 先停止 API/Admin/Worker、先持久启用 `file_rollback` gate，再在 gate 保持激活期间清理上次失败遗留的 holder，等待 Data Access 全局排他锁排空已有 mutation，并检查活动数据库中的 v2 baseline 和全部 projection operation。检查通过后具名 PostgreSQL session 持有同一 exclusive advisory lock，覆盖 release 文件恢复、pre-027 API 启动和健康验证；updater 在每一阶段及健康轮询持续探测 holder，丢失后取消命令并停止旧服务。存在历史或活动 v2 状态时保留 gate 并拒绝 file-only rollback，必须先按数据库备份恢复方案处理。健康通过后 updater 关闭 gate 并确认 holder 释放；若关闭/确认失败，同样停止旧服务并保留 operation。updater 在 `applying/verifying` 中重启时会先停止旧服务，将原 operation 标为只能回滚的失败状态；修复镜像/Compose/服务问题后从 updater 重试同一 rollback，重试会在服务保持停止时清理旧 holder 并重新建立冻结。migration `027 down` 遇 holder/gate 会在取得表独占锁前快速失败。只有确认匹配的发布文件和服务已恢复、健康检查通过且 v2 状态与目标代码兼容时，才可在审计后用数据库管理员执行以下应急解除，不能把它当作普通重试步骤：

数据库仍处于 pre-027（不存在 gate 表）时，holder 不会自行退出；updater 将在旧服务健康检查通过后显式结束具名数据库会话并确认锁释放，不能直接杀掉 holder 继续运行旧服务。对于 migration `027+`，关闭 gate 前仍会在数据库内确认 holder 持锁，确认失败时停止旧服务。回滚停止服务和数据库探针使用固定 release 容器名 `druvia-api`、`druvia-admin`、`druvia-deno`、`druvia-postgres`，不依赖已切换的新 Compose 文件能否解析。apply 在备份复制完成前中断或尚未切换发布文件时无需按旧镜像回滚；文件可能已切换或手工回滚中断则必须保留原始备份 ID，并在重试前检查 `.env.release` 和 `docker-compose.release.yml` 备份都存在。预检发现 v2 状态后不得继续发起其他更新，必须先处理数据库备份/目标版本兼容。

若 gate 已关闭但 holder 释放确认失败，updater 会尽力重新启用 gate 并停止旧服务，状态仍为需要恢复；先确认 gate 与旧服务状态，不可把此次失败视作回滚完成。未知 Hasura 投影写入即使 metadata 回到原始内容，只要 resource version 已前进，恢复仍需关闭相关 authenticated select，不能判为未应用。

回滚重试先保持或启用 `file_rollback` gate，再在 gate 激活时清理旧 holder；预检发现 v2 状态或清理失败时 gate 保持激活，旧服务保持停止。运维应先核对 gate 和数据库备份再确定恢复方向，不得直接重启不兼容的旧 API。完成过列授权收缩的 v2 baseline 还必须与当前 Hasura 列权限一致，历史 target metadata 即使摘要相同也不能作为恢复成功的证据。

手工回滚从更新成功状态发起时，原 `operationId` 通常已清空。updater 在操作准入锁内按当前版本选定备份目录并将其 ID 写入持久回滚状态；重启后重试必须沿用同一备份，不能按新回滚操作 ID 查找，也不要手动修改 update state 来猜测备份。界面确认框中的回滚只恢复发布文件与服务，不自动恢复数据库；若迁移已改变数据库，先核实旧代码与当前 schema 的兼容性。

新 updater 只允许回滚到与当前版本匹配的最近成功 apply 备份；更新检查失败产生的 operation ID 不代表备份。旧 updater 遗留的状态若没有这种独立备份记录，界面回滚会拒绝，而不是按目录时间挑选；运维应核对匹配版本的备份与文件后按人工恢复流程处理。健康发布的备份若已丢失，回滚在准入预检中直接拒绝，不会误把发布标成需要恢复或阻止继续检查/下载更新；已发生的部署回滚失败仍须完成恢复。回滚成功后确认界面的 `currentVersion` 已恢复为备份 env 中的版本。
updater 对 apply 阶段的状态文件执行磁盘同步；重启后如果记录为备份准备/就绪，但当前发布文件与原版本或备份不一致、文件缺失，仍会停止 API/Admin/Worker 并进入回滚恢复，不能按普通下载重试。先核实发布文件、备份目录及数据库状态，再决定恢复方向。

```sql
UPDATE druvia_data_access_runtime_gates
SET active = FALSE, updated_at = NOW()
WHERE gate_name = 'file_rollback';
```

生产应用合同、真实 Project Session 和回退窗口未完成前，不执行 OTA 激活。
