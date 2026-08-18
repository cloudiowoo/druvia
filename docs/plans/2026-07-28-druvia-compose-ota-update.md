# Druvia Compose OTA Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Docker Compose 生产部署中实现类似 Sub2API 的升级体验：Admin 被动通知有新版本、点击“更新”拉取并暂存发布包、点击“重启并应用”完成整套 Druvia 服务升级，失败后可回滚到升级前的镜像与 compose 状态。

**Architecture:** 不在 `api` 或 `admin` 容器内替换二进制。新增一个内网 `updater` 服务持有 Docker socket 和部署目录挂载；API 只做 super_admin 鉴权代理；Admin 只调用 API。生产发布包改为版本化镜像 + release manifest + release compose 文件，升级由 updater 通过受控 `docker compose` 命令执行。

**Tech Stack:** Node.js 22, Fastify 5, Next.js 16, React 19, pnpm 9, turbo, Vitest, Docker Compose v2, GHCR/GitHub Releases 或兼容的私有 manifest endpoint。

---

## Context And Decisions

- Sub2API 参考实现提供的 UX 和安全边界包括：版本检查、更新下载、重启、回滚、操作锁、下载域名白名单、checksum 校验、异步长任务。参考文件：
  - <https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/handler/admin/system_handler.go>
  - <https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/update_service.go>
  - <https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/pkg/sysutil/restart.go>
  - <https://github.com/Wei-Shaw/sub2api/blob/main/deploy/docker-compose.local.yml>
- Druvia 不能照搬 Sub2API 的“容器内替换单个可执行文件”方式。Druvia 是 `api + admin + deno worker + hasura + postgres + redis + nginx` 的 Compose 系统，升级对象是多镜像、多配置和数据库迁移。
- 当前 `docker/docker-compose.prod.yml` 的 `api` 和 `admin` 使用 `build:`，`deno` 使用 `denoland/deno` 加源码挂载。这种形态不能从 Admin UI 拉取远端发布包。保留现有文件给构建式部署使用，新增 release-mode compose。
- Docker socket 只挂载给 `updater`。`api`、`admin`、`deno` 不挂载 Docker socket，避免管理 API 直接获得宿主机控制面。
- 系统更新接口只允许 `platform_user` 且 `role === 'super_admin'`。`apps/api/src/middleware/auth.ts` 已有 `apikey` fallback，controller 必须显式拒绝 `apikey` 和 `project_user`。
- 数据库迁移不承诺无条件自动回滚。manifest 标记 `reversible: false` 时，失败回滚只回滚镜像和 compose 状态，并要求升级前已生成数据库备份。

## Target Operator Flow

1. 运维使用 release compose 启动生产部署：

   ```bash
   DRUVIA_DEPLOY_DIR="$(pwd)" docker compose --env-file .env.prod --env-file .env.release -f docker-compose.release.yml up -d
   ```

   如果使用内置 nginx profile：

   ```bash
   DRUVIA_DEPLOY_DIR="$(pwd)" docker compose --env-file .env.prod --env-file .env.release -f docker-compose.release.yml --profile with-nginx up -d
   ```

2. `updater` 周期性检查 `DRUVIA_RELEASE_MANIFEST_URL`，Admin 登录后的全局布局也会拉取 `/api/v1/system/update/status`。
3. 有新版本时，Admin 顶部展示被动通知；系统设置页展示当前版本、目标版本、迁移风险、发布日期和 release notes 链接。
4. 用户点击“更新”，Admin 调用 API，API 代理到 updater。updater 校验 manifest、拉取目标镜像、写入 staged state，但不重启服务。
5. 用户点击“重启并应用”，updater 在后台执行：保存当前 release 文件快照、执行预检、按 manifest 要求做备份门禁、运行迁移、执行 `docker compose up -d`、健康检查、写入成功状态。
6. 如果健康检查失败，updater 使用升级前的 `.env.release` 和 compose 快照重新 `up -d`。如果 DB 迁移不可逆，UI 展示“应用失败，服务已回滚，数据库需要使用备份人工恢复”的明确状态。
7. 用户可在系统设置页点击“重启服务”，触发 updater 后台执行 `docker compose restart api admin deno`，不改变版本。

## Release Manifest Contract

Create `packages/shared/src/update.ts` and export these shared types from `packages/shared/src/index.ts` so API, Admin, updater, and tests use one contract.

```ts
export type DruviaReleaseChannel = 'stable' | 'beta' | 'nightly';

export interface DruviaReleaseImage {
  repository: string;
  tag: string;
  digest: string;
}

export interface DruviaReleaseManifest {
  schemaVersion: 1;
  product: 'druvia';
  version: string;
  channel: DruviaReleaseChannel;
  createdAt: string;
  minUpdaterVersion: string;
  releaseNotesUrl: string;
  compose: {
    url: string;
    sha256: string;
  };
  images: {
    api: DruviaReleaseImage;
    admin: DruviaReleaseImage;
    worker: DruviaReleaseImage;
    updater: DruviaReleaseImage;
  };
  migrations: {
    required: boolean;
    from: number;
    to: number;
    requiresBackup: boolean;
    reversible: boolean;
  };
}

export type DruviaUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready_to_apply'
  | 'applying'
  | 'restarting'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'rolled_back';

export interface DruviaUpdateStatus {
  enabled: boolean;
  phase: DruviaUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  channel: DruviaReleaseChannel;
  releaseNotesUrl: string | null;
  migration: DruviaReleaseManifest['migrations'] | null;
  operationId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  error: { code: string; message: string } | null;
}
```

## Implementation Steps

### 1. Add Release-Mode Compose And Image Build Files

- [ ] Add `docker/docker-compose.release.yml`.
  - Copy service definitions from `docker/docker-compose.prod.yml`.
  - Keep `postgres`, `redis`, `hasura`, `loki`, `promtail`, `grafana`, `certbot`, and `nginx` behavior identical unless an update-specific environment variable is required.
  - Replace `api.build` with `image: ${DRUVIA_API_IMAGE}`.
  - Add these API service environment entries because Compose `--env-file` does not automatically inject variables into containers:

    ```yaml
    DRUVIA_VERSION: ${DRUVIA_VERSION}
    DRUVIA_UPDATER_URL: ${DRUVIA_UPDATER_URL:-http://updater:3010}
    DRUVIA_UPDATER_SECRET: ${DRUVIA_UPDATER_SECRET}
    ```

  - Replace `admin.build` with `image: ${DRUVIA_ADMIN_IMAGE}`.
  - Replace `deno.image + ./deno-worker:/app:ro` with `image: ${DRUVIA_WORKER_IMAGE}` and keep only `./deno_cache:/deno-dir`.
  - Add `updater` on `druvia-network` with no published port:

    ```yaml
    updater:
      image: ${DRUVIA_UPDATER_IMAGE}
      container_name: druvia-updater
      restart: unless-stopped
      environment:
        NODE_ENV: production
        PORT: 3010
        HOST: 0.0.0.0
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
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock
        - "${DRUVIA_DEPLOY_DIR:?Set DRUVIA_DEPLOY_DIR to an absolute host path}:${DRUVIA_DEPLOY_DIR:?Set DRUVIA_DEPLOY_DIR to an absolute host path}"
        - update_state:/state
      networks:
        - druvia-network
    ```

- [ ] Add `docker/.env.release.example`.

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

- [ ] Add `docker/Dockerfile.worker` for `docker/deno-worker`.
  - Base image: `denoland/deno:alpine-2.0.6`.
  - Build this image with context `docker/deno-worker` because root `.dockerignore` excludes `docker/`.
  - Copy `*.ts` from the worker build context into `/app`.
  - Set `DENO_DIR=/deno-dir`, `WORKDIR /app`, expose `7133`.
  - Use the same command currently defined in `docker-compose.prod.yml`.

- [ ] Update `docker/Dockerfile.api`.
  - Copy `migrations ./migrations` into the runner image.
  - Ensure `apps/api/dist/cli/migrate.js` is present in the runner image.
  - Keep `postgresql-client` because backup/restore already depends on it.

- [ ] Add `docker/Dockerfile.updater` after `apps/updater` exists.
  - Base image: `node:22-alpine`.
  - Install Docker CLI, compose plugin, PostgreSQL client, and wget with `apk add --no-cache docker-cli docker-cli-compose postgresql-client wget`.
  - Copy the built updater app and production dependencies.
  - Healthcheck `wget -q --spider http://localhost:3010/health`.

### 2. Add Release Publishing Pipeline

- [ ] Create `.github/workflows/release.yml`.
  - Trigger on `push` tags matching `v*` and `workflow_dispatch`.
  - Build and push these images to GHCR:
    - `ghcr.io/druvia/druvia-api`
    - `ghcr.io/druvia/druvia-admin`
    - `ghcr.io/druvia/druvia-worker`
    - `ghcr.io/druvia/druvia-updater`
  - Build the worker image with `context: docker/deno-worker` and `file: docker/Dockerfile.worker`.
  - Push two tags for every image: semver without the leading `v`, and the short git SHA.
  - Capture image digests from `docker/build-push-action` outputs.
  - Generate `release-manifest.json` using `scripts/release/generate-manifest.mjs`.
  - Upload `release-manifest.json` and `docker-compose.release.yml` to the GitHub Release.

- [ ] Add `scripts/release/generate-manifest.mjs`.
  - Read `GITHUB_REF_NAME`, image digest outputs, channel, migration floor, migration ceiling, and release notes URL from environment variables.
  - Validate semver format before writing JSON.
  - Compute `compose.sha256` for `docker/docker-compose.release.yml`.
  - Write a deterministic, pretty-printed JSON file with newline at EOF.

### 3. Build `apps/updater`

- [ ] Create `apps/updater/package.json`.

  ```json
  {
    "name": "@druvia/updater",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "scripts": {
      "build": "tsc",
      "dev": "tsx watch src/index.ts",
      "start": "node dist/index.js"
    },
    "dependencies": {
      "@druvia/shared": "workspace:*",
      "fastify": "^5.2.0",
      "semver": "^7.6.3",
      "zod": "^4.3.6"
    },
    "devDependencies": {
      "@types/node": "^20.0.0",
      "@types/semver": "^7.5.8",
      "tsx": "^4.7.0",
      "typescript": "^5.4.0",
      "vitest": "^4.0.18"
    }
  }
  ```

- [ ] Create updater source modules:
  - `apps/updater/src/config.ts`: parse environment variables, fail startup when `DRUVIA_UPDATER_SECRET`, `DRUVIA_RELEASE_MANIFEST_URL`, or `DRUVIA_CURRENT_VERSION` is missing.
  - `apps/updater/src/state.ts`: persist `/state/update-state.json` with atomic write to `/state/update-state.json.tmp` followed by rename.
  - `apps/updater/src/manifest.ts`: fetch, validate, compare semver, validate URL hosts, and verify compose checksum.
  - `apps/updater/src/compose.ts`: run only allowlisted Docker Compose operations through `node:child_process`.
  - `apps/updater/src/postgres-backup.ts`: build and run direct `pg_dump` commands for upgrade-gated backups.
  - `apps/updater/src/update-service.ts`: implement state machine, lock, staged manifest, apply, restart, rollback.
  - `apps/updater/src/index.ts`: Fastify routes and healthcheck.

- [ ] Implement updater auth.
  - All `/internal/*` routes, including `/internal/restart`, require `x-druvia-updater-secret`.
  - `/health` returns `{ "status": "ok" }` without auth.

- [ ] Implement update operation lock.
  - Use one in-memory lock plus state file operation id.
  - A second mutating request during `checking`, `downloading`, `applying`, `restarting`, or `verifying` returns HTTP `409` with `UPDATE_IN_PROGRESS`.
  - Long operations run in the background and HTTP returns `202` with `{ operationId, status }`.

- [ ] Implement Docker and Docker Compose command wrappers with explicit command arrays.

  ```ts
  export type ComposeAction = 'migrate' | 'up' | 'restart' | 'rollbackUp' | 'selfUpdate';

  export interface ComposeOptions {
    projectDirectory: string;
    baseEnvFile: string;
    releaseEnvFile: string;
    composeFile: string;
    profiles: string[];
    managedServices: string[];
  }

  export function buildComposeArgs(action: ComposeAction, options: ComposeOptions): string[] {
    const base = [
      'compose',
      '--project-directory',
      options.projectDirectory,
      '--env-file',
      options.baseEnvFile,
      '--env-file',
      options.releaseEnvFile,
      '-f',
      options.composeFile,
      ...options.profiles.flatMap((profile) => ['--profile', profile]),
    ];
    const services = options.managedServices.length > 0
      ? options.managedServices
      : ['api', 'admin', 'deno', 'hasura'];

    if (action === 'migrate') return [...base, 'run', '--rm', 'api', 'node', 'apps/api/dist/cli/migrate.js', 'up'];
    if (action === 'up') return [...base, 'up', '-d', '--remove-orphans', ...services];
    if (action === 'rollbackUp') return [...base, 'up', '-d', '--remove-orphans', ...services];
    if (action === 'restart') return [...base, 'restart', 'api', 'admin', 'deno'];
    if (action === 'selfUpdate') return [...base, 'up', '-d', 'updater'];
    throw new Error(`Unsupported compose action: ${String(action)}`);
  }

  export function buildDockerImagePullArgs(imageRef: string): string[] {
    return ['image', 'pull', imageRef];
  }
  ```

- [ ] Make env-file names configurable.
  - `DRUVIA_DEPLOY_DIR` must be the absolute host path of the `docker/` deploy directory and must be mounted into updater at the same absolute path because updater runs Docker Compose through the host Docker socket.
  - Default `DRUVIA_BASE_ENV_FILE=<deploy>/.env.prod`.
  - Default `DRUVIA_RELEASE_ENV_FILE=<deploy>/.env.release`.
  - Default `DRUVIA_COMPOSE_FILE=<deploy>/docker-compose.release.yml`.
  - Default `DRUVIA_COMPOSE_PROFILES=` with comma-separated optional profiles.
  - Default `DRUVIA_MANAGED_SERVICES=api,admin,deno,hasura`; include `nginx` only when the deployment intentionally manages built-in nginx through the updater.
  - Tests must verify custom file paths are used in compose args.

- [ ] Implement staging.
  - `check` fetches manifest and sets `available` only when `manifest.version > currentVersion`.
  - `download` pulls all manifest image references by digest using `docker image pull repository@digest`.
  - Download manifest `compose.url` to `<deploy>/docker-compose.release.yml.next` and verify its sha256.
  - Atomically rename `<deploy>/docker-compose.release.yml.next` to `<deploy>/docker-compose.release.yml.staged`.
  - After all image pulls pass, write `<deploy>/.env.release.next` with exact image refs using `repository@digest`.
  - Atomically rename `<deploy>/.env.release.next` to `<deploy>/.env.release.staged`.
  - Set state to `ready_to_apply`.

- [ ] Implement apply.
  - Copy `<deploy>/.env.release` to `/state/backups/<operationId>/.env.release`.
  - Copy `<deploy>/docker-compose.release.yml` to `/state/backups/<operationId>/docker-compose.release.yml`.
  - Abort apply if `<deploy>/.env.release.staged` or `<deploy>/docker-compose.release.yml.staged` is missing.
  - If manifest requires backup, run a direct full database dump from updater before migration:

    ```bash
    pg_dump -h postgres -p 5432 -U postgres -d druvia -F c --no-owner --no-acl -f /state/backups/<operationId>/postgres.dump
    ```

  - Set `PGPASSWORD` from `POSTGRES_PASSWORD` for the dump command.
  - Compute and store `/state/backups/<operationId>/postgres.dump.sha256`.
  - Abort apply before touching `.env.release` if the dump command fails.
  - Rename `<deploy>/docker-compose.release.yml.staged` to `<deploy>/docker-compose.release.yml`.
  - Rename `<deploy>/.env.release.staged` to `<deploy>/.env.release`.
  - Run migration command before replacing app containers.
  - Run compose `up`.
  - Poll `http://api:3001/health`, `http://admin:3000`, `http://deno:7133/health`, and `http://hasura:8080/healthz` for up to 180 seconds.
  - On success, write `succeeded` state and update `currentVersion`.
  - After success, run `docker compose up -d updater` as the final best-effort self-update step; record a warning if this final command fails after core services are healthy.

- [ ] Implement rollback.
  - Restore backed-up `<deploy>/.env.release`.
  - Restore backed-up `<deploy>/docker-compose.release.yml`.
  - Run compose `up -d --remove-orphans` with the configured managed services.
  - Poll the same health endpoints.
  - Write `rolled_back` when service health is restored.
  - Preserve the failed manifest, operation id, stderr excerpts, and rollback result in state.

### 4. Add API Proxy Routes

- [ ] Add API config fields in `apps/api/src/config/index.ts`.

  ```ts
  updater: {
    url: process.env.DRUVIA_UPDATER_URL || '',
    secret: process.env.DRUVIA_UPDATER_SECRET || '',
  },
  version: process.env.DRUVIA_VERSION || process.env.npm_package_version || '0.1.0',
  ```

- [ ] Add `apps/api/src/modules/system-update/system-update.routes.ts`.
  - Define route paths under `/system/*`; `apps/api/src/index.ts` registers the module with prefix `/api/v1`.
  - Add `app.addHook('preHandler', authenticate)`.
  - Every handler calls a shared `requireSuperAdmin(request, reply)`.

  ```ts
  function isSuperAdmin(user: RequestUser | undefined): user is PlatformJwtUser {
    return user?.kind === 'platform_user' && user.role === 'super_admin';
  }
  ```

- [ ] Add `apps/api/src/modules/system-update/system-update.controller.ts`.
  - `GET /system/update/status`
  - `POST /system/update/check`
  - `POST /system/update/download`
  - `POST /system/update/apply`
  - `POST /system/update/rollback`
  - `POST /system/restart`
  - Return `403` for non-super-admin identities.
  - Return `503 UPDATER_NOT_CONFIGURED` if `DRUVIA_UPDATER_URL` or `DRUVIA_UPDATER_SECRET` is missing.
  - Wrap updater responses in the standard external API `{ success, data/error }` envelope without leaking `DRUVIA_UPDATER_SECRET`.

- [ ] Register `systemUpdateRoutes` in `apps/api/src/index.ts` under `/api/v1`.

- [ ] Add root API tests.
  - `tests/unit/api-system-update.test.ts`: unauthenticated requests return `401`; project_user and non-super-admin return `403`; super_admin reaches mocked updater.
  - `tests/unit/api-app.test.ts`: route registration smoke test for `/api/v1/system/update/status`.

### 5. Add Admin Passive Notification And System Update Panel

- [ ] Add shared Admin client methods in `apps/admin/src/lib/api.ts`.
  - `getSystemUpdateStatus()`
  - `checkSystemUpdate()`
  - `downloadSystemUpdate()`
  - `applySystemUpdate()`
  - `rollbackSystemUpdate()`
  - `restartSystemServices()`

- [ ] Add `apps/admin/src/components/system-update/SystemUpdateNotice.tsx`.
  - Render only when current user is `super_admin`.
  - Poll status periodically while the user remains in the dashboard.
  - Show compact top banner when `phase` is `available`, `ready_to_apply`, `failed`, or `rolled_back`.
  - Link to `/settings`.

- [ ] Mount `SystemUpdateNotice` in `apps/admin/src/components/DashboardLayout.tsx` above page content.
  - The banner must not shift or overlap the sidebar.
  - Use existing `card`, `btn`, and neutral utility styles.

- [ ] Extend `apps/admin/src/app/settings/page.tsx`.
  - Add a system update card with `id="updates"` visible only to `super_admin`.
  - Show current version, available version, channel, migration range, backup requirement, release notes link, phase, last message, and last error.
  - Button behavior:
    - “检查更新” calls `checkSystemUpdate`.
    - “更新” calls `downloadSystemUpdate` and is enabled only in `available` or `failed`.
    - “重启并应用” calls `applySystemUpdate` and is enabled only in `ready_to_apply`.
    - “回滚” calls `rollbackSystemUpdate` and is enabled only in `failed`.
    - “重启服务” calls `restartSystem` and is disabled while any mutating phase is active.
  - Use `AlertDialog` confirmation for “重启并应用”, “回滚”, and “重启服务”.
  - When `migration.requiresBackup === true`, the confirmation text must state that a recent backup is required before applying.

- [ ] Add Admin tests.
  - `tests/unit/admin-system-update-ui.test.ts`: static UI/API-client contract for passive notice, settings panel, and operation buttons.

### 6. Add Documentation

- [ ] Add `docs/deployment/docker-compose-update.md`.
  - Explain the release compose startup command.
  - Explain required files: `.env.prod`, `.env.release`.
  - Explain required variables: `DRUVIA_UPDATER_SECRET`, `DRUVIA_RELEASE_MANIFEST_URL`, image refs.
  - Explain update flow from Admin: notification, update, restart/apply, rollback.
  - Explain Docker socket risk and why only updater has the mount.
  - Explain DB rollback limitation for irreversible migrations.

- [ ] Update `docker/.env.prod.example`.
  - Add `DRUVIA_UPDATER_SECRET`.
  - Add `DRUVIA_UPDATER_URL=http://updater:3010`.
  - Add `DRUVIA_VERSION=0.1.0`.
  - Add a note that updater stores migration-required database dumps in the `update_state` volume.
  - Add a note that online update requires `docker-compose.release.yml`, not build-based `docker-compose.prod.yml`.

- [ ] Update `docs/agent/project-memory.md`.
  - Record that production online update is Compose-native and updater-owned.
  - Record that API/Admin must not mount Docker socket.
  - Record that Deno worker production updates use a versioned worker image.

### 7. Verification

- [ ] Unit tests:

  ```bash
  pnpm test tests/unit/update-contract.test.ts tests/unit/update-manifest.test.ts tests/unit/update-state.test.ts tests/unit/update-compose-command.test.ts tests/unit/update-backup-command.test.ts tests/unit/update-command-runner.test.ts tests/unit/release-compose-files.test.ts tests/unit/release-pipeline.test.ts tests/unit/updater-config.test.ts tests/unit/updater-routes.test.ts tests/unit/updater-service.test.ts tests/unit/api-system-update.test.ts tests/unit/api-app.test.ts tests/unit/admin-system-update-ui.test.ts
  ```

- [ ] Build:

  ```bash
  pnpm --filter @druvia/shared build
  pnpm --filter @druvia/updater build
  pnpm --filter @druvia/api build
  pnpm --filter @druvia/admin build
  ```

- [ ] Compose config validation:

  ```bash
  cd docker
  DRUVIA_DEPLOY_DIR="$(pwd)" docker compose --env-file .env.prod --env-file .env.release -f docker-compose.release.yml config
  ```

- [ ] Local dry run with fake updater manifest:
  - Start release compose with locally built image tags.
  - Serve a manifest whose image refs point at local test tags.
  - Click “检查更新”, then “更新”, then “重启并应用”.
  - Confirm `api`, `admin`, `deno`, and `hasura` health checks pass.
  - Confirm `update_state` records `succeeded`.

- [ ] Failure dry run:
  - Stage a manifest with a deliberately broken admin image.
  - Click “更新”, then “重启并应用”.
  - Confirm updater writes `failed`, restores the previous `.env.release`, runs rollback compose, and writes `rolled_back` after health recovers.

## Acceptance Criteria

- Admin shows a passive update notification to `super_admin` only.
- The “更新” button downloads and stages the target release without restarting live services.
- The “重启并应用” button applies staged images through Docker Compose and verifies API, Admin, Deno worker, and Hasura health.
- The “重启服务” button restarts API, Admin, and Deno worker without changing image refs.
- API rejects unauthenticated users, `apikey`, `project_user`, and non-super-admin platform users for every system update operation.
- API does not run Docker commands and does not mount Docker socket.
- Updater is not exposed on a host port and requires `x-druvia-updater-secret`.
- Release manifest validation rejects wrong product, unsupported schema version, invalid semver, downgrade, disallowed URLs, and compose checksum mismatch.
- Production release images contain the migration CLI and the `migrations/` directory.
- Rollback restores the previous `.env.release` and compose file snapshot when service health fails after an apply attempt.
