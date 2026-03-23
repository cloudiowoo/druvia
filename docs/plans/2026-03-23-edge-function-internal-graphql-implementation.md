# Edge Function Internal GraphQL Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a formal internal GraphQL proxy for Druvia Edge Functions so new functions can call `druvia.graphql()` without receiving platform-level Hasura secrets, and migrate `wx-login-register` as the first target pattern.

**Architecture:** The API signs a short-lived internal token at function invoke time, injects it into the execution context, and exposes a dedicated `POST /api/internal/functions/graphql` route that validates the token, restores the project scope, and proxies GraphQL to Hasura with the platform-held admin secret. The Deno worker runtime provides a built-in `druvia.graphql(query, variables?)` helper that uses this internal route; old functions are migrated manually to the new helper.

**Tech Stack:** Fastify 5, Node.js 22, jsonwebtoken, Deno Worker runtime, Vitest, pnpm

---

### Task 1: Add Internal Token Utilities

**Files:**
- Create: `apps/api/src/modules/functions/internal-token.ts`
- Modify: `apps/api/src/modules/functions/functions.service.ts`
- Modify: `apps/api/src/config/index.ts`
- Test: `tests/unit/functions-internal-token.test.ts`

- [ ] **Step 1: Write the failing token tests**

Create tests covering:
- token signing with `projectId`, `functionName`, `authType`, `exp`
- token verification success
- token expiration rejection
- malformed token rejection

Run: `pnpm test tests/unit/functions-internal-token.test.ts`
Expected: FAIL because `internal-token.ts` does not exist yet.

- [ ] **Step 2: Create internal token utility**

Implement `apps/api/src/modules/functions/internal-token.ts` with:
- `InternalFunctionTokenPayload`
- `signInternalFunctionToken(payload)`
- `verifyInternalFunctionToken(token)`

Rules:
- Use a dedicated config value if present
- Fallback to `JWT_SECRET` only for Phase 1 compatibility
- Enforce short expiry suitable for one function execution window

- [ ] **Step 3: Extend config surface**

Update `apps/api/src/config/index.ts` to expose the internal token signing secret and any needed defaults without changing current runtime behavior unexpectedly.

- [ ] **Step 4: Wire signing into function invocation**

Modify `apps/api/src/modules/functions/functions.service.ts` so `invokeFunction()`:
- signs a short-lived internal token after the target function is loaded
- includes it in the worker execution request
- keeps current caller context behavior intact

- [ ] **Step 5: Run token tests**

Run: `pnpm test tests/unit/functions-internal-token.test.ts`
Expected: PASS


### Task 2: Add Internal GraphQL Route

**Files:**
- Create: `apps/api/src/modules/functions/internal-graphql.routes.ts`
- Modify: `apps/api/src/index.ts`
- Test: `tests/unit/functions-internal-graphql.test.ts`
- Test: `tests/unit/api-app.test.ts`

- [ ] **Step 1: Write the failing route tests**

Add tests covering:
- valid internal token allows access
- expired or invalid token returns 401
- route ignores caller-supplied `projectId`
- Hasura proxy receives the token-derived `projectId` scope only

Run: `pnpm test tests/unit/functions-internal-graphql.test.ts tests/unit/api-app.test.ts`
Expected: FAIL because the route is not registered yet.

- [ ] **Step 2: Implement the internal route**

Create `apps/api/src/modules/functions/internal-graphql.routes.ts`:
- define `POST /internal/functions/graphql`
- read internal auth token from a dedicated header
- verify token with `verifyInternalFunctionToken`
- query `druvia_projects` to resolve schema name from token `projectId`
- proxy to Hasura with:
  - `x-hasura-admin-secret`
  - `x-hasura-default-schema`
- return near-raw GraphQL response `{ data, errors }`
- preserve transparent HTTP/network errors for debugging

- [ ] **Step 3: Register the route**

Modify `apps/api/src/index.ts` to register the new internal route under `/api`.

- [ ] **Step 4: Run route tests**

Run: `pnpm test tests/unit/functions-internal-graphql.test.ts tests/unit/api-app.test.ts`
Expected: PASS


### Task 3: Inject Built-In `druvia.graphql()` Helper Into Worker Runtime

**Files:**
- Modify: `docker/deno-worker/main.ts`
- Modify: `docker/deno-worker/executor.ts`
- Test: `tests/unit/functions-service.test.ts`

- [ ] **Step 1: Add a failing runtime/helper test**

Extend `tests/unit/functions-service.test.ts` to assert the worker request includes the internal token and any information needed for runtime helper construction.

Run: `pnpm test tests/unit/functions-service.test.ts`
Expected: FAIL because the worker payload does not yet include helper credentials.

- [ ] **Step 2: Extend worker execute payload**

Modify `docker/deno-worker/main.ts` and the corresponding API caller payload to include:
- internal token
- API base URL needed by the helper

Do not expose Hasura URL or admin secrets to user code.

- [ ] **Step 3: Build the helper in executor**

Modify `docker/deno-worker/executor.ts` so the execution context includes:

```ts
druvia.graphql(query, variables?)
```

Behavior:
- POST to `/api/internal/functions/graphql`
- send internal token in a dedicated header
- return parsed `{ data, errors }`
- do not require user code to pass `projectId`
- keep helper available to new functions in both execution modes used by the runtime design

- [ ] **Step 4: Preserve current caller context**

Ensure existing trusted caller headers and context remain available; the new helper is additive and should not break existing invoke auth behavior.

- [ ] **Step 5: Run service tests**

Run: `pnpm test tests/unit/functions-service.test.ts`
Expected: PASS


### Task 4: Document the New Function Authoring Contract

**Files:**
- Modify: `docs/agent/project-memory.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/agent/playbooks.md`
- Modify: `docs/progress.md`

- [ ] **Step 1: Update project memory**

Document that:
- platform-level Hasura secrets are not the formal function model
- new functions should use `druvia.graphql()`
- internal token is execution-time only and not a project secret

- [ ] **Step 2: Update design decision summary**

Record the lasting rule:
- platform secrets stay server-side
- internal function access goes through API internal proxy

- [ ] **Step 3: Update playbook / progress**

Add:
- migration guidance for old functions
- verification checklist for the internal GraphQL route
- milestone note that the platform gained a formal internal function data path


### Task 5: Verify End-to-End Platform Behavior

**Files:**
- Test: `tests/unit/functions-internal-token.test.ts`
- Test: `tests/unit/functions-internal-graphql.test.ts`
- Test: `tests/unit/functions-service.test.ts`
- Test: `tests/unit/functions-controller.test.ts`
- Test: `tests/unit/api-app.test.ts`

- [ ] **Step 1: Run the focused unit suite**

Run:

```bash
pnpm test \
  tests/unit/functions-internal-token.test.ts \
  tests/unit/functions-internal-graphql.test.ts \
  tests/unit/functions-service.test.ts \
  tests/unit/functions-controller.test.ts \
  tests/unit/api-app.test.ts
```

Expected:
- all tests pass
- no regression in invoke auth mode behavior

- [ ] **Step 2: Build the API package**

Run: `pnpm --filter @druvia/api build`
Expected: build succeeds

- [ ] **Step 3: Validate the migration path manually**

Manual checklist:
- publish a function version using `druvia.graphql()`
- confirm function secrets no longer require Hasura admin credentials
- invoke `wx-login-register`-style flow successfully
- confirm cross-project access is impossible from the helper path

- [ ] **Step 4: Commit**

```bash
git add \
  apps/api/src/config/index.ts \
  apps/api/src/index.ts \
  apps/api/src/modules/functions/internal-token.ts \
  apps/api/src/modules/functions/internal-graphql.routes.ts \
  apps/api/src/modules/functions/functions.service.ts \
  docker/deno-worker/main.ts \
  docker/deno-worker/executor.ts \
  tests/unit/functions-internal-token.test.ts \
  tests/unit/functions-internal-graphql.test.ts \
  tests/unit/functions-service.test.ts \
  tests/unit/functions-controller.test.ts \
  tests/unit/api-app.test.ts \
  docs/agent/project-memory.md \
  docs/agent/design-decisions.md \
  docs/agent/playbooks.md \
  docs/progress.md \
  docs/plans/2026-03-23-edge-function-internal-graphql-design.md \
  docs/plans/2026-03-23-edge-function-internal-graphql-implementation.md
git commit -m "feat(functions): add internal graphql helper for edge functions"
```
