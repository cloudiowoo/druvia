# Project User Auth Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build formal project-user authentication for mini-program style apps so Druvia API, Functions, RPC, and SDK can use API-issued project-user sessions instead of Edge Functions self-signing JWTs.

**Architecture:** Add a dedicated `project-auth` API module that reuses project provider config and project schema `users` table, then introduce a distinct `project_user` identity branch in middleware/auth. Phase 1 deliberately stops at project auth APIs, Functions `jwt_required`, and RPC authentication; GraphQL project-user support stays out of scope.

**Tech Stack:** Fastify 5, PostgreSQL 17, jsonwebtoken, existing auth adapters, Vitest, `@druvia/sdk`

---

## File Structure

### New API module

- Create: `apps/api/src/modules/project-auth/project-auth.routes.ts`
- Create: `apps/api/src/modules/project-auth/project-auth.controller.ts`
- Create: `apps/api/src/modules/project-auth/project-auth.service.ts`

Responsibility:
- define project-scoped auth endpoints
- exchange WeChat code using existing provider config
- load/create/update project users from `<schema>.users`
- issue/revoke project-user access and refresh tokens

### Shared auth foundation

- Modify: `apps/api/src/middleware/auth.ts`
- Modify: `apps/api/src/config/index.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/lib/access.ts`

Responsibility:
- split request identity into `platform_user` / `project_user` / `apikey`
- add project-user token signing and verification helpers
- register new routes
- keep existing platform auth behavior stable

### Existing modules that must accept project-user JWT

- Modify: `apps/api/src/modules/functions/functions.controller.ts`
- Modify: `apps/api/src/modules/functions/functions.service.ts`
- Modify: `docker/deno-worker/executor.ts`
- Modify: `apps/api/src/modules/rpc/rpc.controller.ts`

Responsibility:
- keep management endpoints platform-user only
- allow invoke/RPC business access for same-project `project_user`
- propagate caller context clearly
- keep Worker runtime caller headers/context aligned with the new `project_user` shape

### Database and schema

- Create: `migrations/016_project_user_auth_phase1.up.sql`
- Create: `migrations/016_project_user_auth_phase1.down.sql`

Responsibility:
- add project-user refresh token infrastructure
- avoid cross-schema FK coupling for project user ids

### SDK

- Create: `packages/sdk/src/modules/project-auth.ts`
- Modify: `packages/sdk/src/DruviaClient.ts`
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/modules/functions.ts`
- Modify: `packages/sdk/src/modules/rpc.ts`

Responsibility:
- expose project auth APIs without overloading existing platform `auth`
- keep project-user session storage separate from platform-user session storage
- ensure only project-scoped modules consume project-user access tokens in Phase 1
- keep taro-app migration path explicit

### Tests

- Create: `tests/unit/project-auth.service.test.ts`
- Create: `tests/unit/project-auth.controller.test.ts`
- Modify: `tests/unit/auth.test.ts`
- Modify: `tests/unit/functions-controller.test.ts`
- Modify: `tests/unit/api-app.test.ts`
- Create: `tests/sdk/project-auth.test.ts`

Responsibility:
- verify token model split
- verify same-project project-user auth rules
- verify SDK request/response contract

### Docs

- Modify: `docs/agent/project-memory.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/agent/playbooks.md`
- Modify: `docs/progress.md`

Responsibility:
- record the new identity split and migration path

---

### Task 1: Add Project-User Refresh Token Infrastructure

**Files:**
- Create: `migrations/016_project_user_auth_phase1.up.sql`
- Create: `migrations/016_project_user_auth_phase1.down.sql`
- Test: no direct SQL unit test; verify via existing migrate workflow and service tests in later tasks

- [ ] **Step 1: Write the migration**

Add `public.druvia_project_refresh_tokens` with at least:

```sql
CREATE TABLE druvia_project_refresh_tokens (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Also add indexes:

```sql
CREATE INDEX idx_project_refresh_tokens_project_user
  ON druvia_project_refresh_tokens(project_id, user_id);

CREATE INDEX idx_project_refresh_tokens_expires
  ON druvia_project_refresh_tokens(expires_at) WHERE revoked = false;
```

- [ ] **Step 2: Add rollback migration**

```sql
DROP TABLE IF EXISTS druvia_project_refresh_tokens;
```

- [ ] **Step 3: Run migration locally**

Run: `pnpm --filter @druvia/api exec node --import tsx/esm src/cli/migrate.ts up`

Expected:
- migration `016_project_user_auth_phase1` applied successfully

- [ ] **Step 4: Commit**

```bash
git add migrations/016_project_user_auth_phase1.up.sql migrations/016_project_user_auth_phase1.down.sql
git commit -m "feat(db): add project user refresh token infrastructure"
```

---

### Task 2: Split Request Identity Model In Auth Middleware

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`
- Modify: `apps/api/src/config/index.ts`
- Modify: `tests/unit/auth.test.ts`

- [ ] **Step 1: Write failing auth tests**

Add tests for:
- signing/verifying platform user token still works
- signing/verifying project-user token works
- `isPlatformUser()` and `isProjectUser()` discriminate correctly

Suggested payload shape:

```ts
{
  kind: 'project_user',
  sub: '9f8c...',
  projectId: 'proj_123',
  authType: 'project_user',
  role: 'authenticated',
  provider: 'wechat',
}
```

- [ ] **Step 2: Run the focused auth test**

Run: `pnpm test tests/unit/auth.test.ts`

Expected: FAIL because project-user helpers and types do not exist yet

- [ ] **Step 3: Implement minimal middleware changes**

In `apps/api/src/middleware/auth.ts`:
- replace `JwtPayload` / `RequestUser` with explicit discriminated types:
  - `PlatformJwtUser`
  - `ProjectJwtUser`
  - `ApiKeyIdentity`
- keep apikey branch as `{ kind: 'apikey', projectId, role: 'anon' }`
- add helper functions:
  - `isPlatformUser(user)`
  - `isProjectUser(user)`
  - `isApiKeyUser(user)`
- add project-user token sign/verify helpers, either:
  - extend `signToken()` with a discriminated payload
  - or add dedicated `signProjectUserToken()` / `verifyProjectUserToken()`
- update `authenticate()` and `optionalAuth()` to populate `request.user.kind`

In `apps/api/src/config/index.ts`:
- add `projectAuth.tokenSecret` fallback order:
  - `PROJECT_AUTH_JWT_SECRET`
  - fallback `JWT_SECRET`
- add `projectAuth.defaultAccessTokenTtlSeconds`

- [ ] **Step 4: Re-run the auth test**

Run: `pnpm test tests/unit/auth.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/config/index.ts tests/unit/auth.test.ts
git commit -m "feat(api): split platform and project user auth identities"
```

---

### Task 3: Build Project Auth API Module

**Files:**
- Create: `apps/api/src/modules/project-auth/project-auth.routes.ts`
- Create: `apps/api/src/modules/project-auth/project-auth.controller.ts`
- Create: `apps/api/src/modules/project-auth/project-auth.service.ts`
- Modify: `apps/api/src/modules/auth-admin/auth-admin.service.ts`
- Modify: `apps/api/src/index.ts`
- Create: `tests/unit/project-auth.service.test.ts`
- Create: `tests/unit/project-auth.controller.test.ts`
- Modify: `tests/unit/api-app.test.ts`

- [ ] **Step 1: Write failing service and controller tests**

Cover at least:
- `POST /api/v1/projects/:projectId/auth/wechat/login`
  - creates missing project user when `allow_signup = true`
- `POST /api/v1/projects/:projectId/auth/wechat/silent-login`
  - returns `USER_NOT_FOUND` if no user exists
- legacy taro-app user with only `wx_open_id` is still found by silent-login/login
- `POST /api/v1/projects/:projectId/auth/refresh`
  - rotates refresh token
- `POST /api/v1/projects/:projectId/auth/logout`
  - requires project-user JWT and revokes tokens
- `buildApp()` exposes the new routes

- [ ] **Step 2: Run the new failing tests**

Run:

```bash
pnpm test tests/unit/project-auth.service.test.ts tests/unit/project-auth.controller.test.ts tests/unit/api-app.test.ts
```

Expected: FAIL because the module does not exist yet

- [ ] **Step 3: Implement `project-auth.service.ts`**

Use these existing building blocks:
- provider config from `apps/api/src/modules/auth-admin/auth-admin.service.ts`
- WeChat exchange from `apps/api/src/adapters/auth/wechat.adapter.ts`
- project schema lookup from `druvia_projects`

Service responsibilities:
- `getProjectAuthConfig(projectId)`
- `getProjectSchema(projectId)`
- `inspectProjectUserColumns(schemaName)`
- `exchangeWechatCode(projectId, mode, code)`
- `findProjectUserByWechatIdentity(schemaName, openid)`
- `createProjectUser(schemaName, provider, providerId, profile)`
- `updateProjectUserLastLogin(schemaName, userId)`
- `createProjectRefreshToken(projectId, userId, provider, ttlSeconds)`
- `consumeProjectRefreshToken(projectId, rawToken)`
- `revokeProjectRefreshTokens(projectId, userId)`
- `issueProjectSession(projectId, projectUser, provider, authConfig)`

Keep SQL schema-safe:
- validate `schemaName` before interpolating
- use `pg-format` or a shared helper for identifier formatting

Compatibility rule:
- do not assume `provider_id` or `last_login_at` already exist
- Phase 1 must work against the currently observed taro-app shape:
  - `wx_open_id` exists
  - `provider_id` absent
  - `last_login_at` absent
- lookup order for WeChat identity:
  1. `provider = 'wechat' AND provider_id = <openid>` when target columns exist
  2. fallback `wx_open_id = <openid>` when legacy column exists
- on create/update:
  - write `provider = 'wechat'` and `provider_id = <openid>` when target columns exist
  - also write `wx_open_id = <openid>` when legacy column exists
  - only update `last_login_at` when the column exists

Do not put this logic into `oauth.service.ts`; keep tenant OAuth and project auth separate.

- [ ] **Step 4: Implement routes and controllers**

Add routes:

```ts
POST /projects/:projectId/auth/wechat/login
POST /projects/:projectId/auth/wechat/silent-login
POST /projects/:projectId/auth/refresh
POST /projects/:projectId/auth/logout
```

Controller rules:
- login / silent-login are public
- refresh is public but consumes refresh token for the target project
- logout requires authenticated `project_user`
- return consistent shape:

```json
{
  "success": true,
  "data": {
    "token": "...",
    "refreshToken": "...",
    "expiresIn": 3600,
    "user": { ... }
  }
}
```

- [ ] **Step 5: Register the routes**

In `apps/api/src/index.ts`:
- import `projectAuthRoutes`
- register under `/api/v1`

- [ ] **Step 6: Re-run project-auth/API app tests**

Run:

```bash
pnpm test tests/unit/project-auth.service.test.ts tests/unit/project-auth.controller.test.ts tests/unit/api-app.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/project-auth apps/api/src/index.ts tests/unit/project-auth.service.test.ts tests/unit/project-auth.controller.test.ts tests/unit/api-app.test.ts
git commit -m "feat(api): add project user auth endpoints"
```

---

### Task 4: Allow Project-User JWT In Function Invoke

**Files:**
- Modify: `apps/api/src/modules/functions/functions.controller.ts`
- Modify: `apps/api/src/modules/functions/functions.service.ts`
- Modify: `docker/deno-worker/executor.ts`
- Modify: `tests/unit/functions-controller.test.ts`
- Modify: `tests/unit/functions-service.test.ts`

- [ ] **Step 1: Add failing function invoke tests**

Add tests for:
- `jwt_required` function invoke succeeds with same-project `project_user`
- `jwt_required` function invoke rejects cross-project `project_user`
- function CRUD endpoints still reject non-platform users

`caller` assertions should distinguish:
- `authType: 'project_user'`
- `projectId`
- project user id field, e.g. `projectUserId`
- keep follow-up implementation in sync with the Deno worker caller model; update `docker/deno-worker/executor.ts` if caller shape changes

- [ ] **Step 2: Run the function controller test**

Run: `pnpm test tests/unit/functions-controller.test.ts`

Expected: FAIL because `verifyInvokeAccess()` only understands platform JWT and anonymous apikey

- [ ] **Step 3: Implement the invoke branch**

In `functions.controller.ts`:
- keep `verifyProjectAccess()` management paths platform-user only
- update `verifyInvokeAccess()`:
  - `platform_user`: current behavior
  - `project_user`: require `user.projectId === request.params.projectId`
  - `apikey`: current `anon_allowed` branch

In `functions.service.ts`:
- widen `FunctionCallerContext` from `authType: 'jwt' | 'apikey'` to:

```ts
authType: 'platform_user' | 'project_user' | 'apikey'
projectUserId?: string
provider?: string
```

Do not remove existing platform fields:
- `userId`
- `uid`
- `tenantId`

They are still needed for platform-user calls.

In `docker/deno-worker/executor.ts`:
- update the worker-side `caller` type to recognize `project_user`
- propagate project-user context through trusted headers and runtime context, for example:
  - `x-druvia-auth-type: project_user`
  - `x-druvia-project-user-id`
  - `x-druvia-provider`
- do not overload `x-druvia-user-id` with project-user identity

- [ ] **Step 4: Re-run the function controller test**

Run: `pnpm test tests/unit/functions-controller.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/functions/functions.controller.ts apps/api/src/modules/functions/functions.service.ts tests/unit/functions-controller.test.ts
git commit -m "feat(functions): accept project user jwt for invoke"
```

---

### Task 5: Add Project-User Authentication Branch To RPC

**Files:**
- Modify: `apps/api/src/modules/rpc/rpc.controller.ts`
- Modify: `apps/api/src/lib/access.ts`
- Create: `tests/unit/rpc-controller.test.ts`
- Modify: `tests/unit/rpc.test.ts`

- [ ] **Step 1: Write failing RPC controller tests**

Add coverage for:
- same-project `project_user` can invoke RPC
- cross-project `project_user` gets `403`
- anonymous apikey still gets `401` or `403` for RPC
- platform user keeps current behavior

- [ ] **Step 2: Run the RPC tests**

Run:

```bash
pnpm test tests/unit/rpc-controller.test.ts tests/unit/rpc.test.ts
```

Expected: FAIL because controller only checks `userId`

- [ ] **Step 3: Implement minimal RPC auth support**

In `rpc.controller.ts`:
- use new auth helpers from middleware
- `platform_user`: keep `checkProjectAccess(userId, projectId)`
- `project_user`: allow only if `user.projectId === projectId`
- `apikey`: reject

In `apps/api/src/lib/access.ts`:
- keep existing owner/platform helpers unchanged
- if needed, add a small helper such as:

```ts
export function checkProjectUserScope(userProjectId: string, projectId: string): boolean
```

Do not pretend Phase 1 solves per-user RPC authorization inside SQL functions.

- [ ] **Step 4: Re-run the RPC tests**

Run:

```bash
pnpm test tests/unit/rpc-controller.test.ts tests/unit/rpc.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/rpc/rpc.controller.ts apps/api/src/lib/access.ts tests/unit/rpc-controller.test.ts tests/unit/rpc.test.ts
git commit -m "feat(rpc): support project user authentication"
```

---

### Task 6: Add Project Auth Support To SDK

**Files:**
- Create: `packages/sdk/src/modules/project-auth.ts`
- Modify: `packages/sdk/src/DruviaClient.ts`
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/modules/functions.ts`
- Modify: `packages/sdk/src/modules/rpc.ts`
- Create: `tests/sdk/project-auth.test.ts`
- Modify: `tests/sdk/client.test.ts`

- [ ] **Step 1: Write failing SDK tests**

Add tests for:
- `client.projectAuth.wechatLogin()` POSTs to `/projects/:projectId/auth/wechat/login`
- `client.projectAuth.wechatSilentLogin()` POSTs to `/projects/:projectId/auth/wechat/silent-login`
- `client.projectAuth.refreshSession()` POSTs to `/projects/:projectId/auth/refresh`
- `client.projectAuth.logout()` POSTs to `/projects/:projectId/auth/logout`
- `client.projectAuth.getUser()` reads from local `druvia.project_session` and does not require a server `auth/me` route in Phase 1
- project auth session is stored under a dedicated key such as `druvia.project_session`
- platform `auth` session key `druvia.session` remains unchanged
- `functions` / `rpc` use project auth token resolution
- project auth login does not overwrite platform `auth` session storage

- [ ] **Step 2: Run the failing SDK tests**

Run:

```bash
pnpm test tests/sdk/project-auth.test.ts tests/sdk/client.test.ts
```

Expected: FAIL because `projectAuth` module does not exist

- [ ] **Step 3: Implement the SDK module**

Create `packages/sdk/src/modules/project-auth.ts` with methods:

```ts
wechatLogin(params: { code: string; userInfo?: Record<string, unknown> })
wechatSilentLogin(params: { code: string })
refreshSession(params: { refresh_token: string })
logout()
getSession()
getUser()
signOut()
```

Implementation notes:
- use `/projects/${projectId}/auth/...` endpoints
- persist session under a dedicated storage key, e.g. `druvia.project_session`
- return Supabase-like nested response where appropriate
- `getSession()` and `getUser()` are Phase 1 local-session helpers:
  - `getSession()` reads `druvia.project_session`
  - `getUser()` returns `session.user` from that same storage
  - do not add a new backend `GET /projects/:projectId/auth/me` route in this phase

Token injection rule:
- do not reuse the existing single `cachedToken` path in `DruviaClient`
- introduce a distinct project-session token resolver
- in Phase 1:
  - `functions` and `rpc` should use project-session token first
  - platform `auth` keeps using platform session
  - `database/graphql`, `storage`, and other modules should not silently switch to project-user auth in this phase

In `packages/sdk/src/types.ts`:
- either widen `UserInfo.id` to `string | number`
- or add `ProjectUserInfo` and `ProjectSession`

Recommendation for Phase 1:
- widen to `string | number`
- keep shape minimal to reduce taro-app migration churn

In `packages/sdk/src/DruviaClient.ts`:
- add `readonly projectAuth`
- initialize it with the same fetch/storage stack
- add a separate project-scoped authenticated fetch path instead of reusing the existing platform-auth cached token for every module

- [ ] **Step 4: Re-run the SDK tests**

Run:

```bash
pnpm test tests/sdk/project-auth.test.ts tests/sdk/client.test.ts tests/sdk/auth.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/modules/project-auth.ts packages/sdk/src/DruviaClient.ts packages/sdk/src/types.ts tests/sdk/project-auth.test.ts tests/sdk/client.test.ts
git commit -m "feat(sdk): add project auth client for mini-program users"
```

---

### Task 7: Update Docs And Migration Guidance

**Files:**
- Modify: `docs/agent/project-memory.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/agent/playbooks.md`
- Modify: `docs/progress.md`

- [ ] **Step 1: Update project memory**

Record:
- platform user vs project user split
- project auth routes
- Functions/RPC `jwt_required` now accept project-user JWT
- GraphQL project-user still out of scope

- [ ] **Step 2: Update playbooks**

Add a new troubleshooting section:
- project auth login succeeds but RPC fails
- refresh token invalid after migration
- same-project check for `project_user` JWT

- [ ] **Step 3: Update progress**

Mark:
- project user auth Phase 1 implemented
- taro-app should migrate away from self-signed Edge Function sessions

- [ ] **Step 4: Commit**

```bash
git add docs/agent/project-memory.md docs/agent/design-decisions.md docs/agent/playbooks.md docs/progress.md
git commit -m "docs: record project user auth phase 1"
```

---

### Task 8: Run Full Verification And Prepare Handoff

**Files:**
- Modify only if verification reveals real defects

- [ ] **Step 1: Run focused API tests**

Run:

```bash
pnpm test \
  tests/unit/auth.test.ts \
  tests/unit/project-auth.service.test.ts \
  tests/unit/project-auth.controller.test.ts \
  tests/unit/functions-controller.test.ts \
  tests/unit/rpc-controller.test.ts \
  tests/unit/rpc.test.ts \
  tests/unit/api-app.test.ts
```

Expected: all pass

- [ ] **Step 2: Run focused SDK tests**

Run:

```bash
pnpm test \
  tests/sdk/auth.test.ts \
  tests/sdk/project-auth.test.ts \
  tests/sdk/client.test.ts \
  tests/sdk/functions.test.ts
```

Expected: all pass

- [ ] **Step 3: Run API build**

Run: `pnpm --filter @druvia/api build`

Expected: build succeeds

- [ ] **Step 4: Run SDK build or type verification**

Run one of:

```bash
pnpm --filter @druvia/sdk build
```

or, if no dedicated build script exists:

```bash
pnpm test tests/sdk/auth.test.ts tests/sdk/project-auth.test.ts tests/sdk/client.test.ts
```

- [ ] **Step 5: Manual migration checklist**

Verify before closing:
- project auth provider config exists for target project
- project schema `users` table is checked for legacy compatibility:
  - `wx_open_id` may still be the active lookup field
  - `provider_id` / `last_login_at` may be absent
- taro-app no longer depends on Edge Function self-signed session
- `wx-login-register` / `wx-silent-login` are either removed or converted to thin API proxies
- project auth session storage is isolated from platform auth session storage

- [ ] **Step 6: Final commit**

```bash
git status
git commit -m "feat(auth): add project user auth phase 1"
```

---

## Notes For Implementers

- Keep platform user auth routes and semantics unchanged unless a task explicitly says otherwise.
- Do not overload existing `/api/v1/auth/*` platform user endpoints for project auth.
- Do not claim project-user GraphQL support in this phase.
- Do not hide the RPC authorization limitation; Phase 1 solves authentication mismatch, not complete per-user SQL authorization.
- Prefer adding new unit tests over broad integration work first; the repo already has strong unit-test coverage around auth/functions/sdk seams.
