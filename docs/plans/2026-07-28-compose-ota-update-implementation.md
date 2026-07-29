# Docker Compose OTA 升级实施文档

> 状态：初版已实施，待真实生产演练
> 关联执行计划：`docs/superpowers/plans/2026-07-28-druvia-compose-ota-update.md`
> 适用部署：Druvia 自托管 Docker Compose 生产环境
> 日期：2026-07-28

## 0. 2026-07-28 实施状态

本方案的代码初版已落地，覆盖 release-mode compose、发布 manifest、updater 内部服务、API super_admin 代理、Admin 被动通知和设置页操作入口。

已实现入口：

- `packages/shared/src/update.ts`
- `apps/updater`
- `apps/api/src/modules/system-update/*`
- `apps/admin/src/components/system-update/*`
- `docker/docker-compose.release.yml`
- `docker/.env.release.example`
- `docker/Dockerfile.worker`
- `docker/Dockerfile.updater`
- `.github/workflows/release.yml`
- `scripts/release/generate-manifest.mjs`

仍需生产演练确认：

- GHCR 四镜像真实发布
- 从旧 release 到新 release 的端到端升级
- 故障 release 的自动回滚
- `postgres.dump` 通过 `pg_restore --list` 验证可用
- 私有 registry / 私有 manifest endpoint 的鉴权部署方式

## 1. 背景

用户希望 Druvia 在生产发布包中具备类似 Sub2API 的在线升级体验：

- 界面被动通知有新版本。
- 点击“更新”下载或拉取新版本。
- 点击“重启”或“重启并应用”完成升级。
- 在 Docker Compose 生产部署中完成整个程序的发布包升级，而不是只升级单个服务。

Sub2API 的实现适合单二进制程序：服务检查 GitHub Release，下载对应平台压缩包，校验 checksum，替换当前可执行文件，再通过进程退出让 systemd 或容器 restart policy 拉起新进程。Druvia 当前是多服务 Compose 系统，包含 API、Admin、Deno Worker、Hasura、PostgreSQL、Redis、可选 nginx 和日志组件，因此不能照搬“容器内替换可执行文件”的机制。

本实施文档采用 Compose-native 方案：新增独立 `updater` 服务，由它持有 Docker socket 和部署目录，负责发布 manifest 校验、镜像拉取、发布状态持久化、compose 应用、健康检查和回滚。API 只负责鉴权代理，Admin 只负责展示和操作入口。

## 2. 目标

### 2.1 用户体验目标

- super_admin 登录 Admin 后能被动看到新版本提醒。
- 系统设置页展示当前版本、可升级版本、渠道、迁移范围、备份要求和发布说明。
- “更新”只拉取并暂存新版本，不重启在线服务。
- “重启并应用”才切换镜像、执行迁移、重建服务并做健康检查。
- “重启服务”只重启 API、Admin、Deno Worker，不改变版本。
- 失败时展示明确状态，并在可恢复范围内自动回滚到升级前镜像与 compose 状态。

### 2.2 工程目标

- 生产部署从本地 `build:` 改为 release-mode 的版本化镜像引用。
- Deno Worker 生产环境改为版本化镜像，不再依赖宿主机挂载源码作为升级对象。
- API、Admin 不挂载 Docker socket。
- Updater 服务不暴露宿主机端口，只接受内网调用和 shared secret。
- 发布 manifest 明确声明版本、渠道、镜像 digest、compose 文件 checksum、迁移范围和回滚语义。
- 数据库迁移前具备强制备份门禁。

## 3. 非目标

- 不实现容器内热替换 JS/TS 文件。
- 不让 API 直接执行 Docker 命令。
- 不支持匿名用户、项目用户或项目 `apikey` 触发系统升级。
- 不承诺不可逆数据库迁移的自动数据库回滚。
- 不把在线升级绑定到 GitHub。GitHub Releases 是默认实现，manifest URL 可换成私有发布服务。

## 4. 当前 Druvia 部署现状

当前生产 Compose 文件为 `docker/docker-compose.prod.yml`。

关键事实：

- `api` 使用本仓库源码 `build:`。
- `admin` 使用本仓库源码 `build:`。
- `deno` 使用 `denoland/deno:alpine-2.0.6`，并挂载 `./deno-worker:/app:ro`。
- `api` 健康检查是 `GET /health`。
- `deno` 健康检查是 `GET /health`。
- `hasura` 健康检查是 `GET /healthz`。
- `api` 生产 Dockerfile 当前需要确保复制 `migrations/`，否则新版本镜像无法执行迁移 CLI。
- 备份/恢复正式策略已经偏向直连 `pg_dump` / `pg_restore`，而不是生产 API 绑定 Docker socket。

因此需要新增 release-mode compose，保留现有 `docker-compose.prod.yml` 给构建式部署和手工部署继续使用。

## 5. 总体架构

```text
Admin UI
  |
  | Bearer platform JWT
  v
API /api/v1/system/*
  |
  | x-druvia-updater-secret
  v
Updater internal service
  |
  | Docker CLI + Docker Compose CLI
  v
Docker daemon
  |
  | compose up / restart / image pull
  v
Druvia services: api, admin, deno, hasura, optional nginx
```

服务职责：

| 组件 | 职责 | 禁止事项 |
|------|------|----------|
| Admin | 展示通知、状态、按钮、确认弹窗 | 不直接访问 updater |
| API | 平台 JWT 鉴权、super_admin 授权、代理 updater | 不挂 Docker socket，不执行 Docker 命令 |
| Updater | 检查 manifest、拉镜像、备份、迁移、compose 应用、健康检查、回滚 | 不暴露宿主机端口 |
| Docker daemon | 执行镜像和容器变更 | 只通过 updater 的 allowlist 命令触发 |
| PostgreSQL | 保存业务数据和元数据 | 不依赖镜像回滚自动还原数据 |

## 6. 发布包结构

### 6.1 版本化镜像

每次 Druvia 发布需要产出四个核心镜像：

| 镜像 | 示例 |
|------|------|
| API | `ghcr.io/druvia/druvia-api:0.1.0` |
| Admin | `ghcr.io/druvia/druvia-admin:0.1.0` |
| Worker | `ghcr.io/druvia/druvia-worker:0.1.0` |
| Updater | `ghcr.io/druvia/druvia-updater:0.1.0` |

发布 manifest 必须使用 digest 作为最终应用引用：

```dotenv
DRUVIA_API_IMAGE=ghcr.io/druvia/druvia-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
DRUVIA_ADMIN_IMAGE=ghcr.io/druvia/druvia-admin@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
DRUVIA_WORKER_IMAGE=ghcr.io/druvia/druvia-worker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
DRUVIA_UPDATER_IMAGE=ghcr.io/druvia/druvia-updater@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
```

运行态 `.env.release` 可以显示 tag 对应版本，但实际镜像引用以 digest 为准，避免 `latest` 或 tag 被覆盖后造成不可重复升级。

### 6.2 Release Manifest

共享类型放在 `packages/shared/src/update.ts`，并从 `packages/shared/src/index.ts` 导出，由 API、Admin、Updater 共用。

Manifest 示例：

```json
{
  "schemaVersion": 1,
  "product": "druvia",
  "version": "0.2.0",
  "channel": "stable",
  "createdAt": "2026-07-28T00:00:00.000Z",
  "minUpdaterVersion": "0.1.0",
  "releaseNotesUrl": "https://github.com/druvia/druvia/releases/tag/v0.2.0",
  "compose": {
    "url": "https://github.com/druvia/druvia/releases/download/v0.2.0/docker-compose.release.yml",
    "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  },
  "images": {
    "api": {
      "repository": "ghcr.io/druvia/druvia-api",
      "tag": "0.2.0",
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "admin": {
      "repository": "ghcr.io/druvia/druvia-admin",
      "tag": "0.2.0",
      "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "worker": {
      "repository": "ghcr.io/druvia/druvia-worker",
      "tag": "0.2.0",
      "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    "updater": {
      "repository": "ghcr.io/druvia/druvia-updater",
      "tag": "0.2.0",
      "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  },
  "migrations": {
    "required": true,
    "from": 17,
    "to": 18,
    "requiresBackup": true,
    "reversible": false
  }
}
```

校验规则：

- `schemaVersion` 必须为 `1`。
- `product` 必须为 `druvia`。
- `version` 必须是合法 semver，且高于当前版本。
- `channel` 必须匹配本机配置的升级渠道。
- `compose.url` 的 host 必须在 `DRUVIA_RELEASE_ALLOWED_HOSTS` 内。
- 下载的 compose 文件 sha256 必须等于 manifest 中的 `compose.sha256`。
- 镜像 digest 必须以 `sha256:` 开头。
- `minUpdaterVersion` 高于当前 updater 版本时，状态返回 `UPDATER_TOO_OLD`，要求先手工升级 updater。

## 7. Release Compose

新增 `docker/docker-compose.release.yml`。

与 `docker-compose.prod.yml` 的差异：

- `api` 从 `build:` 改为 `image: ${DRUVIA_API_IMAGE}`。
- `admin` 从 `build:` 改为 `image: ${DRUVIA_ADMIN_IMAGE}`。
- `deno` 从基础 Deno 镜像加源码挂载改为 `image: ${DRUVIA_WORKER_IMAGE}`。
- 新增 `updater` 服务。
- 新增 `update_state` volume。
- 保留 `postgres_data`、`redis_data`、`deno_cache`、`with-nginx`、`with-logs` 等既有生产部署语义。

基础启动命令：

```bash
cd docker
DRUVIA_DEPLOY_DIR="$(pwd)" docker compose --env-file .env.prod --env-file .env.release -f docker-compose.release.yml up -d
```

如果使用内置 nginx profile：

```bash
cd docker
DRUVIA_DEPLOY_DIR="$(pwd)" docker compose --env-file .env.prod --env-file .env.release -f docker-compose.release.yml --profile with-nginx up -d
```

`.env.release` 初始内容示例：

```dotenv
DRUVIA_VERSION=0.1.0
DRUVIA_UPDATE_CHANNEL=stable
DRUVIA_RELEASE_MANIFEST_URL=https://github.com/druvia/druvia/releases/latest/download/release-manifest.json
DRUVIA_RELEASE_ALLOWED_HOSTS=api.github.com,github.com,raw.githubusercontent.com,objects.githubusercontent.com
DRUVIA_UPDATER_SECRET=change_me_to_a_random_32_char_min_secret
DRUVIA_DEPLOY_DIR=/absolute/path/to/Druvia/docker
DRUVIA_BASE_ENV_FILE=
DRUVIA_RELEASE_ENV_FILE=
DRUVIA_COMPOSE_FILE=
DRUVIA_COMPOSE_PROFILES=
DRUVIA_MANAGED_SERVICES=api,admin,deno,hasura
DRUVIA_API_IMAGE=ghcr.io/druvia/druvia-api:0.1.0
DRUVIA_ADMIN_IMAGE=ghcr.io/druvia/druvia-admin:0.1.0
DRUVIA_WORKER_IMAGE=ghcr.io/druvia/druvia-worker:0.1.0
DRUVIA_UPDATER_IMAGE=ghcr.io/druvia/druvia-updater:0.1.0
```

`.env.prod` 增加：

```dotenv
DRUVIA_VERSION=0.1.0
DRUVIA_UPDATER_URL=http://updater:3010
DRUVIA_UPDATER_SECRET=change_me_to_a_random_32_char_min_secret
```

注意：

- Compose 的 `--env-file` 主要用于变量插值，不等于自动注入到容器环境。`docker-compose.release.yml` 必须在 service 的 `environment:` 中显式声明运行时需要读取的变量。
- `DRUVIA_DEPLOY_DIR` 必须是宿主机上 `docker/` 部署目录的绝对路径，并且 updater 容器要把该路径挂载到同一个绝对路径。原因是 updater 通过 Docker socket 调宿主 Docker daemon；如果只把宿主目录挂到容器内 `/deploy`，容器内运行的 `docker compose` 会把 bind mount 源解析成宿主不存在的 `/deploy/...`。
- 下文命令中的 `<deploy>` 均表示 `DRUVIA_DEPLOY_DIR` 指向的宿主绝对路径。

API service 至少要增加：

```yaml
DRUVIA_VERSION: ${DRUVIA_VERSION}
DRUVIA_UPDATER_URL: ${DRUVIA_UPDATER_URL:-http://updater:3010}
DRUVIA_UPDATER_SECRET: ${DRUVIA_UPDATER_SECRET}
```

Updater service 至少要增加：

```yaml
DRUVIA_UPDATER_SECRET: ${DRUVIA_UPDATER_SECRET}
DRUVIA_CURRENT_VERSION: ${DRUVIA_VERSION}
DRUVIA_UPDATE_CHANNEL: ${DRUVIA_UPDATE_CHANNEL:-stable}
DRUVIA_RELEASE_MANIFEST_URL: ${DRUVIA_RELEASE_MANIFEST_URL}
DRUVIA_RELEASE_ALLOWED_HOSTS: ${DRUVIA_RELEASE_ALLOWED_HOSTS:-api.github.com,github.com,raw.githubusercontent.com,objects.githubusercontent.com}
DRUVIA_DEPLOY_DIR: ${DRUVIA_DEPLOY_DIR:?Set DRUVIA_DEPLOY_DIR to an absolute host path}
DRUVIA_STATE_DIR: /state
DRUVIA_BASE_ENV_FILE: ${DRUVIA_BASE_ENV_FILE:-}
DRUVIA_RELEASE_ENV_FILE: ${DRUVIA_RELEASE_ENV_FILE:-}
DRUVIA_COMPOSE_FILE: ${DRUVIA_COMPOSE_FILE:-}
DRUVIA_COMPOSE_PROFILES: ${DRUVIA_COMPOSE_PROFILES:-}
DRUVIA_MANAGED_SERVICES: ${DRUVIA_MANAGED_SERVICES:-api,admin,deno,hasura}
DB_HOST: postgres
DB_PORT: 5432
DB_USER: postgres
DB_NAME: druvia
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
```

## 8. Updater 服务

### 8.1 运行方式

新增 `apps/updater`，使用 Node.js 22 + Fastify。

容器要求：

- 安装 Docker CLI 和 Docker Compose v2 plugin。
- 安装 PostgreSQL client，升级前备份使用 `pg_dump`。
- 挂载 `/var/run/docker.sock:/var/run/docker.sock`。
- 将宿主 `docker/` 部署目录以 `DRUVIA_DEPLOY_DIR:DRUVIA_DEPLOY_DIR` 形式挂载，保证容器内 compose 看到的绝对路径也是宿主有效路径。
- 挂载 `update_state` 到 `/state`。
- 不发布宿主机端口。

### 8.2 状态文件

状态文件路径：

```text
/state/update-state.json
```

状态结构：

```json
{
  "enabled": true,
  "phase": "idle",
  "currentVersion": "0.1.0",
  "availableVersion": null,
  "channel": "stable",
  "releaseNotesUrl": null,
  "migration": null,
  "operationId": null,
  "startedAt": null,
  "finishedAt": null,
  "message": null,
  "error": null
}
```

写入规则：

- 所有写入先写 `/state/update-state.json.tmp`。
- `fs.rename` 原子替换为 `/state/update-state.json`。
- 下载成功后的 staged manifest 保存为 `/state/staged-manifest.json`。
- 下载并校验后的 release compose 暂存为 `<deploy>/docker-compose.release.yml.staged`。

### 8.3 状态机

```text
idle
  -> checking
  -> available
  -> downloading
  -> ready_to_apply
  -> applying
  -> restarting
  -> verifying
  -> succeeded

failed
  -> downloading
  -> ready_to_apply
  -> applying

failed
  -> rolled_back
```

并发规则：

- `checking`、`downloading`、`applying`、`restarting`、`verifying` 期间只允许读状态。
- 第二个写操作返回 HTTP `409 UPDATE_IN_PROGRESS`。
- 长任务立即返回 HTTP `202`，实际操作在后台继续执行。

### 8.4 内部接口

Updater 只接受 API 内网调用。

| Method | Path | 行为 |
|--------|------|------|
| GET | `/health` | 无鉴权健康检查 |
| GET | `/internal/update/status` | 返回当前状态 |
| POST | `/internal/update/check` | 检查 manifest |
| POST | `/internal/update/download` | 拉取镜像并写入 staged release |
| POST | `/internal/update/apply` | 应用 staged release |
| POST | `/internal/update/rollback` | 回滚到最近一次升级前 release |
| POST | `/internal/restart` | 重启 API、Admin、Deno Worker |

除 `/health` 外，所有接口必须校验：

```http
x-druvia-updater-secret: <DRUVIA_UPDATER_SECRET>
```

### 8.5 受控命令

Updater 不接受任意 shell 字符串。所有命令以固定 argv 数组构造。

镜像拉取：

```bash
docker image pull ghcr.io/druvia/druvia-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
docker image pull ghcr.io/druvia/druvia-admin@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
docker image pull ghcr.io/druvia/druvia-worker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
docker image pull ghcr.io/druvia/druvia-updater@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
```

迁移：

```bash
docker compose --project-directory <deploy> --env-file <deploy>/.env.prod --env-file <deploy>/.env.release -f <deploy>/docker-compose.release.yml run --rm api node apps/api/dist/cli/migrate.js up
```

应用默认只管理核心服务：

```bash
docker compose --project-directory <deploy> --env-file <deploy>/.env.prod --env-file <deploy>/.env.release -f <deploy>/docker-compose.release.yml up -d --remove-orphans api admin deno hasura
```

如果生产部署由 Druvia 内置 nginx profile 承担入口，将 `.env.release` 中的 `DRUVIA_COMPOSE_PROFILES` 设为 `with-nginx`，并将 `DRUVIA_MANAGED_SERVICES` 扩展为 `api,admin,deno,hasura,nginx`。不要在默认 apply 命令里无条件包含 `nginx`，否则外置反向代理部署会被误拉起内置 nginx；也不要把 `certbot` 放入常规 managed services，证书签发和续期保持 bootstrap / cron 流程。

重启：

```bash
docker compose --project-directory <deploy> --env-file <deploy>/.env.prod --env-file <deploy>/.env.release -f <deploy>/docker-compose.release.yml restart api admin deno
```

Updater 自升级：

```bash
docker compose --project-directory <deploy> --env-file <deploy>/.env.prod --env-file <deploy>/.env.release -f <deploy>/docker-compose.release.yml up -d updater
```

## 9. 更新流程

### 9.1 检查更新

1. Admin 调用 `POST /api/v1/system/update/check`。
2. API 校验用户是 `platform_user + super_admin`。
3. API 代理到 updater。
4. Updater 拉取 manifest。
5. Updater 校验 manifest。
6. 如果版本高于当前版本，状态变为 `available`。
7. 如果无新版本，状态回到 `idle`，message 写入“当前已是最新版本”。

### 9.2 下载并暂存

1. Admin 调用 `POST /api/v1/system/update/download`。
2. Updater 重新拉取并校验 manifest。
3. Updater 按 digest 拉取 API、Admin、Worker、Updater 镜像。
4. Updater 下载 release compose 文件到 `<deploy>/docker-compose.release.yml.next` 并校验 sha256。
5. Updater 将 `docker-compose.release.yml.next` 原子替换为 `docker-compose.release.yml.staged`。
6. Updater 写入 `<deploy>/.env.release.next`。
7. Updater 将 `.env.release.next` 原子替换为 `.env.release.staged`。
8. 状态变为 `ready_to_apply`。

### 9.3 重启并应用

1. Admin 弹出确认框，展示迁移和备份要求。
2. Admin 调用 `POST /api/v1/system/update/apply`。
3. Updater 复制当前 `.env.release` 和 `docker-compose.release.yml` 到 `/state/backups/<operationId>/`。
4. 如果 manifest 要求备份，Updater 执行完整 `pg_dump`：

   ```bash
   pg_dump -h postgres -p 5432 -U postgres -d druvia -F c --no-owner --no-acl -f /state/backups/<operationId>/postgres.dump
   ```

5. Updater 计算并保存 `postgres.dump.sha256`。
6. Updater 确认 `<deploy>/.env.release.staged` 和 `<deploy>/docker-compose.release.yml.staged` 都存在，否则中止 apply。
7. Updater 将 `docker-compose.release.yml.staged` 替换为 `docker-compose.release.yml`。
8. Updater 将 `.env.release.staged` 替换为 `.env.release`。
9. Updater 执行迁移 CLI。
10. Updater 对 configured managed services 执行 compose `up -d`。
11. Updater 轮询健康检查：
   - `http://api:3001/health`
   - `http://admin:3000`
   - `http://deno:7133/health`
   - `http://hasura:8080/healthz`
12. 所有健康检查通过后，状态变为 `succeeded`。
13. Updater 执行自身服务更新。该步骤是最终 best-effort 动作；如果核心服务已健康但 updater 自升级失败，状态保持 `succeeded` 并记录 warning。

### 9.4 失败回滚

触发条件：

- 镜像拉取失败。
- compose 文件 checksum 不匹配。
- 升级前备份失败。
- 迁移失败。
- compose 应用失败。
- 健康检查超时。

回滚动作：

1. 恢复 `/state/backups/<operationId>/.env.release` 到 `<deploy>/.env.release`。
2. 恢复 `/state/backups/<operationId>/docker-compose.release.yml` 到 `<deploy>/docker-compose.release.yml`。
3. 对 configured managed services 执行 compose `up -d --remove-orphans`。
4. 轮询健康检查。
5. 健康恢复后状态变为 `rolled_back`。
6. 如果迁移已经执行且 manifest `reversible === false`，状态 message 必须明确提示数据库可能已经前向迁移，需要使用 `/state/backups/<operationId>/postgres.dump` 人工恢复。

## 10. API 实施

新增模块：

```text
apps/api/src/modules/system-update/system-update.routes.ts
apps/api/src/modules/system-update/system-update.controller.ts
```

新增配置：

```ts
updater: {
  url: process.env.DRUVIA_UPDATER_URL || '',
  secret: process.env.DRUVIA_UPDATER_SECRET || '',
},
version: process.env.DRUVIA_VERSION || process.env.npm_package_version || '0.1.0',
```

路由挂载：

```ts
app.register(systemUpdateRoutes, { prefix: '/api/v1' });
```

外部 API：

| Method | Path | 权限 |
|--------|------|------|
| GET | `/api/v1/system/update/status` | super_admin |
| POST | `/api/v1/system/update/check` | super_admin |
| POST | `/api/v1/system/update/download` | super_admin |
| POST | `/api/v1/system/update/apply` | super_admin |
| POST | `/api/v1/system/update/rollback` | super_admin |
| POST | `/api/v1/system/restart` | super_admin |

权限判断：

```ts
function isSuperAdmin(user: RequestUser | undefined): user is PlatformJwtUser {
  return user?.kind === 'platform_user' && user.role === 'super_admin';
}
```

错误语义：

| 条件 | HTTP | code |
|------|------|------|
| 未登录 | 401 | `UNAUTHORIZED` |
| `apikey`、`project_user`、非 super_admin | 403 | `FORBIDDEN` |
| updater 未配置 | 503 | `UPDATER_NOT_CONFIGURED` |
| updater 连接失败 | 502 | `UPDATER_UNAVAILABLE` |
| updater 返回冲突 | 409 | `UPDATE_IN_PROGRESS` |

API 不记录或返回 `DRUVIA_UPDATER_SECRET`。

## 11. Admin 实施

新增 API client 方法：

```ts
api.getSystemUpdateStatus()
api.checkSystemUpdate()
api.downloadSystemUpdate()
api.applySystemUpdate()
api.rollbackSystemUpdate()
api.restartSystemServices()
```

新增组件：

```text
apps/admin/src/components/system-update/SystemUpdateNotice.tsx
apps/admin/src/components/system-update/SystemUpdatePanel.tsx
```

挂载位置：

```text
apps/admin/src/components/DashboardLayout.tsx
```

设置页扩展：

```text
apps/admin/src/app/settings/page.tsx
```

UI 行为：

- 只有 `user.role === 'super_admin'` 才显示系统更新区域。
- DashboardLayout 周期性读取状态并在有新版本、待应用、失败或已回滚时展示被动通知。
- `downloading`、`applying`、`restarting`、`verifying` 阶段每 3 秒轮询一次。
- `available` 展示“发现新版本”。
- `ready_to_apply` 展示“新版本已准备好，需重启应用”。
- `failed` 展示错误和可回滚入口。
- `rolled_back` 展示回滚结果。
- 全局通知链接到 `/settings#updates`，系统更新卡片使用 `id="updates"`。

按钮规则：

| 按钮 | 可用状态 |
|------|----------|
| 检查更新 | 非 mutating 状态 |
| 更新 | `available` 或 `failed` |
| 重启并应用 | `ready_to_apply` |
| 回滚 | `failed` |
| 重启服务 | `idle`、`available`、`ready_to_apply`、`succeeded`、`rolled_back` |

危险操作必须使用确认弹窗：

- “重启并应用”
- “回滚”
- “重启服务”

当 `migration.requiresBackup === true` 时，确认弹窗必须展示升级前备份说明。

## 12. 发布流水线

新增：

```text
.github/workflows/release.yml
scripts/release/generate-manifest.mjs
```

流水线职责：

1. tag 触发，例如 `v0.2.0`。
2. 构建四个镜像。
3. 推送 semver tag 和 git SHA tag。
4. 获取每个镜像 digest。
5. 计算 `docker-compose.release.yml` sha256。
6. 生成 `release-manifest.json`。
7. 将 manifest 和 compose 文件上传到 GitHub Release。

Worker 镜像构建必须使用 `docker/deno-worker` 作为 build context，并使用 `docker/Dockerfile.worker` 作为 Dockerfile。根 `.dockerignore` 排除了 `docker/` 目录，不能用仓库根 context 再从 Dockerfile 里 `COPY docker/deno-worker`。

Manifest 生成脚本必须做本地校验：

- tag 是合法 semver。
- migration `from <= to`。
- digest 非空且以 `sha256:` 开头。
- release notes URL 非空。
- compose 文件存在且 sha256 可计算。

## 13. 数据库迁移与备份策略

升级前备份采用 updater 直连 PostgreSQL 完整 dump。

原因：

- 系统升级影响的是平台 schema、租户元数据、项目 schema 和迁移版本表，不适合只备份单个项目 schema。
- API 现有备份服务偏项目和 schema 粒度，不等于系统升级备份。
- Updater 已经是受控运维服务，适合持有 `pg_dump` 工具，但不需要暴露给外部。

备份文件：

```text
/state/backups/<operationId>/postgres.dump
/state/backups/<operationId>/postgres.dump.sha256
/state/backups/<operationId>/.env.release
/state/backups/<operationId>/docker-compose.release.yml
```

迁移规则：

- 迁移命令在新 API 镜像中执行。
- API 镜像必须包含 `migrations/` 目录。
- 迁移失败后不继续 compose `up`。
- manifest `reversible === false` 时，只自动回滚服务镜像和 compose 状态。
- 恢复数据库必须使用升级前生成的 dump 手工执行，UI 要明确显示 dump 路径。

## 14. 安全边界

系统更新属于宿主机级能力，安全策略必须保守：

- API 路由只允许 `platform_user + super_admin`。
- API 必须显式拒绝项目 `apikey` fallback。
- Updater 不发布宿主机端口。
- Updater secret 不进入浏览器。
- Docker socket 只挂载给 updater。
- Updater 只运行 allowlist 命令数组，不接受任意命令字符串。
- Release manifest 只允许白名单 host。
- 镜像应用使用 digest，不使用可变 `latest`。
- 操作日志不得输出数据库密码、JWT secret、Hasura admin secret、updater secret。

## 15. 分期实施

### Phase 1: 发布形态基础

交付：

- `docker/docker-compose.release.yml`
- `docker/.env.release.example`
- `docker/Dockerfile.worker`
- `docker/Dockerfile.updater`
- API 镜像复制 `migrations/`
- release manifest shared type

验收：

- `DRUVIA_DEPLOY_DIR="$(pwd)" docker compose --env-file .env.prod --env-file .env.release -f docker-compose.release.yml config` 通过。
- 本地构建的 release 镜像可以启动 API、Admin、Deno Worker。
- API 镜像内可执行 `node apps/api/dist/cli/migrate.js status`。

### Phase 2: Updater MVP

交付：

- `apps/updater`
- 状态文件
- manifest 校验
- 镜像 digest 拉取
- staged `.env.release`
- apply、restart、rollback
- 健康检查

验收：

- 假 manifest 能从 `idle` 走到 `ready_to_apply`。
- `apply` 成功后状态为 `succeeded`。
- 故障镜像能触发服务回滚。

### Phase 3: API 和 Admin 集成

交付：

- API system-update 模块
- Admin API client 方法
- `SystemUpdateNotice`
- Settings 更新面板
- 确认弹窗和按钮状态机

验收：

- 非 super_admin 看不到更新入口。
- `apikey` 和 `project_user` 调用系统更新 API 返回 403。
- super_admin 能完成检查、下载、应用、重启、回滚流程。

### Phase 4: 发布流水线

交付：

- GitHub Actions release workflow
- manifest 生成脚本
- GHCR 镜像发布
- Release assets 上传

验收：

- tag 发布会生成四个镜像。
- release manifest 包含四个 digest。
- updater 可以用 release manifest 完成检查和拉取。

### Phase 5: 文档和生产演练

交付：

- `docs/deployment/docker-compose-update.md`
- `.env.prod.example` 更新
- 生产演练记录

验收：

- 从旧 release 升到新 release 成功。
- 故障 release 可回滚。
- 升级前 dump 可用 `pg_restore --list` 验证。

## 16. 测试清单

单元测试：

```bash
pnpm test tests/unit/update-contract.test.ts tests/unit/update-manifest.test.ts tests/unit/update-state.test.ts tests/unit/update-compose-command.test.ts tests/unit/update-backup-command.test.ts tests/unit/update-command-runner.test.ts tests/unit/release-compose-files.test.ts tests/unit/release-pipeline.test.ts tests/unit/updater-config.test.ts tests/unit/updater-routes.test.ts tests/unit/updater-service.test.ts tests/unit/api-system-update.test.ts tests/unit/api-app.test.ts tests/unit/admin-system-update-ui.test.ts
```

构建：

```bash
pnpm --filter @druvia/shared build
pnpm --filter @druvia/updater build
pnpm --filter @druvia/api build
pnpm --filter @druvia/admin build
```

Compose 校验：

```bash
cd docker
DRUVIA_DEPLOY_DIR="$(pwd)" docker compose --env-file .env.prod --env-file .env.release -f docker-compose.release.yml config
```

本地配置文件语法可用 example 文件快速校验：

```bash
cd docker
docker compose --env-file .env.prod.example --env-file .env.release.example -f docker-compose.release.yml config --quiet
```

升级演练：

```bash
cd docker
DRUVIA_DEPLOY_DIR="$(pwd)" docker compose --env-file .env.prod --env-file .env.release -f docker-compose.release.yml up -d
DRUVIA_DEPLOY_DIR="$(pwd)" docker compose --env-file .env.prod --env-file .env.release -f docker-compose.release.yml ps
```

健康检查：

```bash
curl -f http://localhost:${API_PORT:-3001}/health
curl -f http://localhost:${ADMIN_PORT:-3000}
curl -f http://localhost:${DENO_PORT:-7133}/health
curl -f http://localhost:${HASURA_PORT:-8080}/healthz
```

## 17. 验收标准

- 生产部署可以使用 release compose 和版本化镜像启动。
- Admin 被动通知在有新版本时显示给 super_admin。
- “更新”只完成拉取和暂存，不重启服务。
- “重启并应用”执行备份、迁移、compose 应用和健康检查。
- “重启服务”只重启运行服务，不修改 `.env.release`。
- 失败后恢复升级前 `.env.release` 和 compose 文件。
- API 和 Admin 不持有 Docker socket。
- Updater 不暴露宿主机端口。
- Release manifest 的版本、渠道、host、checksum、digest 校验全部生效。
- 不可逆迁移失败后，UI 明确提示数据库需要使用升级前 dump 人工恢复。

## 18. 风险与处理

| 风险 | 处理 |
|------|------|
| Docker socket 权限过大 | 只给 updater 挂载，不给 API/Admin 挂载；updater 不开放公网端口 |
| `latest` 被覆盖导致不可重复升级 | manifest 记录 digest，`.env.release` 使用 digest |
| DB 迁移不可逆 | 升级前强制完整 dump，UI 不承诺自动 DB 回滚 |
| 更新过程中浏览器断开 | updater 后台继续执行，状态写入 `/state/update-state.json` |
| 多次点击导致并发升级 | updater 操作锁返回 `409 UPDATE_IN_PROGRESS` |
| compose 文件被篡改 | manifest sha256 校验 |
| 私有镜像仓库鉴权失败 | 下载阶段失败，不进入 apply |
| updater 自身升级中断 | 自身升级作为最后一步执行，失败不影响已完成的业务服务升级 |

## 19. 与 Sub2API 的差异总结

| 点 | Sub2API | Druvia |
|----|---------|--------|
| 升级对象 | 单个二进制 | 多个服务镜像和 compose 状态 |
| 更新执行者 | 当前应用进程 | 独立 updater 服务 |
| 重启机制 | 进程退出后由 systemd 或容器重启 | updater 调用 Docker Compose |
| 校验 | GitHub asset checksum | manifest、compose checksum、镜像 digest、host 白名单 |
| 回滚 | 替换回旧二进制 | 恢复 `.env.release`、compose 快照和旧镜像 |
| 数据库迁移 | 无核心 DB 迁移复杂度 | 必须处理迁移、备份和不可逆风险 |

结论：Druvia 可以实现 Sub2API 风格的界面体验，但底层必须采用 Docker Compose 原生升级模型，而不是容器内文件替换模型。
