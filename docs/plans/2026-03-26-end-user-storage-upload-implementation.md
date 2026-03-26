# End User Storage Upload Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the formal Edge Function proxy upload path for end-user images so Druvia functions can upload to project storage without `DRUVIA_TOKEN`, starting with taro-app style `upload-avatar` and `upload-team-logo`.

**Architecture:** Reuse the existing internal function token model and add a dedicated internal storage upload route that restores project scope and caller context from execution-time credentials only. Extend the Deno worker built-in `druvia` helper with a narrow `storage.upload()` capability, then update storage metadata so uploads triggered by `project_user` through functions remain auditable.

**Tech Stack:** Fastify 5, Node.js 22, PostgreSQL 17, Deno Worker runtime, Vitest, pnpm

**Spec:** `docs/plans/2026-03-26-end-user-storage-upload-design.md`

---

## File Structure

### Internal function upload API

- Create: `apps/api/src/modules/functions/internal-storage.routes.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/modules/functions/functions.service.ts`

Responsibility:
- expose `POST /api/internal/functions/storage/upload`
- accept only internal function token
- bind uploads to the token-derived `projectId`
- restore caller audit identity from the signed internal token, not request body

### Storage core and audit

- Modify: `apps/api/src/modules/storage/storage.service.ts`
- Modify: `apps/api/src/modules/storage/storage.controller.ts`

Responsibility:
- add a storage upload service path that accepts trusted function-internal audit metadata
- preserve existing bucket/path/mime/size validation
- extend storage object `metadata` JSONB for `source_function` and caller identity

### Deno worker runtime helper

- Modify: `docker/deno-worker/druvia-helper.ts`
- Modify: `docker/deno-worker/executor.ts`

Responsibility:
- add `druvia.storage.upload(...)`
- add `druvia.storage.remove(...)`
- route helper calls to the new internal upload API
- keep helper scoped to execution-time internal token only

### Tests

- Modify: `tests/unit/druvia-helper.test.ts`
- Create: `tests/unit/functions-internal-storage.test.ts`
- Modify: `tests/unit/functions-service.test.ts`
- Modify: `tests/unit/api-app.test.ts`
- Modify: `tests/integration/storage.test.ts`

Responsibility:
- prove internal upload route only accepts internal token
- verify project binding and caller audit mapping
- verify helper request shape and runtime availability
- verify helper remove flow for image replacement
- verify storage metadata persistence after upload

### Docs and memory

- Modify: `docs/agent/project-memory.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`
- Modify: `docs/plans/2026-03-26-end-user-storage-upload-design.md`
- Modify: `docs/plans/2026-03-26-end-user-storage-upload-implementation.md`

Responsibility:
- record that `DRUVIA_TOKEN` is not the formal model
- document `druvia.storage.upload()` as the new Phase 1 function contract
- capture migration and audit requirements for future sessions

---

### Task 1: Add Storage Upload Audit Metadata

**Files:**
- Modify: `apps/api/src/modules/storage/storage.service.ts`
- Test: `tests/integration/storage.test.ts`

- [ ] **Step 1: Write the failing integration expectation**

Extend `tests/integration/storage.test.ts` with a scenario that expects uploaded object metadata to include:
- `metadata.created_by_type`
- `metadata.created_by_platform_user_id`
- `metadata.created_by_project_user_id`
- `metadata.source_function`
- and, for same-path re-upload, the metadata is refreshed to the new caller/function

Run: `pnpm test tests/integration/storage.test.ts`
Expected: FAIL because the metadata mapping and write path do not exist yet.

- [ ] **Step 2: Extend storage object mapping**

Update `apps/api/src/modules/storage/storage.service.ts` row types and `toStorageObject()` mapping so the new metadata can be read back in tests and APIs.

- [ ] **Step 3: Run the focused storage integration test**

Run: `pnpm test tests/integration/storage.test.ts`
Expected: still FAIL, but now on missing write-path handling instead of missing metadata mapping.


### Task 2: Add Internal Functions Storage Upload Route

**Files:**
- Create: `apps/api/src/modules/functions/internal-storage.routes.ts`
- Modify: `apps/api/src/index.ts`
- Test: `tests/unit/functions-internal-storage.test.ts`
- Test: `tests/unit/api-app.test.ts`

- [ ] **Step 1: Write the failing route tests**

Create `tests/unit/functions-internal-storage.test.ts` covering:
- valid internal token allows upload
- invalid or expired token returns 401
- request body `projectId` is ignored if present
- upload fails when bucket does not belong to the token-derived project
- path traversal like `../x.jpg` returns 400

Also extend `tests/unit/api-app.test.ts` to assert `/api/internal/functions/storage/upload` is registered and returns 401 without token.

Run:

```bash
pnpm test tests/unit/functions-internal-storage.test.ts tests/unit/api-app.test.ts
```

Expected: FAIL because the route does not exist yet.

- [ ] **Step 2: Reuse the existing internal token payload unless strictly needed**

Prefer to keep the current internal token payload unchanged unless the route truly needs fields beyond:
- `projectId`
- `functionName`
- `authType`

Do not add user identity into the signed token if it is already available via trusted execution context passed from API to worker.

- [ ] **Step 3: Implement the internal storage route**

Create `apps/api/src/modules/functions/internal-storage.routes.ts` with:
- `POST /internal/functions/storage/upload`
- header `x-druvia-internal-token`
- token verification via `verifyInternalFunctionToken()`
- request body:

```ts
{
  bucket: string
  path: string
  contentType: string
  dataBase64: string
}
```

Rules:
- trust `projectId` from token only
- reject empty bucket/path/data
- sanitize path using the same policy as public storage upload
- add explicit `bodyLimit` sized for base64 JSON upload bodies
- do not treat route `bodyLimit` as a replacement for bucket `file_size_limit`
- look up bucket by token-derived `projectId`
- if the runtime helper internally attaches `callerContext`, treat it as worker-internal transport only, not part of the function-authoring helper API
- do not add a public helper parameter or request body field that lets function code set or override caller identity
- call a storage service function that accepts trusted audit context

- [ ] **Step 4: Register the route**

Modify `apps/api/src/index.ts` to register the new route under `/api`.

- [ ] **Step 5: Run the route tests**

Run:

```bash
pnpm test tests/unit/functions-internal-storage.test.ts tests/unit/api-app.test.ts
```

Expected: PASS


### Task 3: Teach Storage Service To Accept Trusted Function Audit Context

**Files:**
- Modify: `apps/api/src/modules/storage/storage.service.ts`
- Modify: `apps/api/src/modules/storage/storage.controller.ts`
- Test: `tests/unit/functions-internal-storage.test.ts`
- Test: `tests/integration/storage.test.ts`

- [ ] **Step 1: Write the failing service behavior assertions**

Add assertions that a function-triggered upload stores:
- `metadata.created_by_type = 'project_user'` for project-user callers
- `metadata.created_by_project_user_id`
- `metadata.source_function`
- and same-path uploads refresh those metadata values on conflict update

Run:

```bash
pnpm test tests/unit/functions-internal-storage.test.ts tests/integration/storage.test.ts
```

Expected: FAIL because `uploadObject()` only accepts `userId`.

- [ ] **Step 2: Introduce a narrow audit input type**

In `apps/api/src/modules/storage/storage.service.ts`, add a dedicated type such as:

```ts
interface StorageUploadAuditContext {
  createdByType?: 'platform_user' | 'project_user' | 'apikey'
  platformUserId?: string
  projectUserId?: string
  sourceFunction?: string
}
```

- [ ] **Step 3: Extend the upload service signature minimally**

Refactor `uploadObject()` to accept the new audit context instead of a single `userId?: string`.

Keep all existing validation logic intact:
- file size
- mime type
- storage backend upload order
- rollback cleanup behavior
- on `ON CONFLICT (bucket_id, name)`, refresh audit metadata as well as file metadata

- [ ] **Step 4: Preserve existing public controller behavior**

Update `apps/api/src/modules/storage/storage.controller.ts` so current protected API uploads still map their platform-user request into the new audit context:

```ts
{
  createdByType: 'platform_user',
  platformUserId: request.user.userId
}
```

Do not broaden current public storage API auth in this phase.

- [ ] **Step 5: Re-run the storage tests**

Run:

```bash
pnpm test tests/unit/functions-internal-storage.test.ts tests/integration/storage.test.ts
```

Expected: PASS


### Task 4: Add `druvia.storage.upload()` And `druvia.storage.remove()` To The Worker Helper

**Files:**
- Modify: `docker/deno-worker/druvia-helper.ts`
- Modify: `docker/deno-worker/executor.ts`
- Modify: `apps/api/src/modules/functions/functions.service.ts`
- Modify: `tests/unit/druvia-helper.test.ts`
- Modify: `tests/unit/functions-service.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Extend `tests/unit/druvia-helper.test.ts` to cover:
- `druvia.storage.upload()` posts to `/api/internal/functions/storage/upload`
- `druvia.storage.remove()` posts to `/api/internal/functions/storage/remove`
- the helper sends `bucket`, `path`, `contentType`, `dataBase64`
- it includes the same internal token header as GraphQL helper

Extend `tests/unit/functions-service.test.ts` to assert the worker request payload still includes:
- `internalToken`
- `caller`
- `apiBaseUrl`

Run:

```bash
pnpm test tests/unit/druvia-helper.test.ts tests/unit/functions-service.test.ts
```

Expected: FAIL because the helper does not expose storage yet.

- [ ] **Step 2: Extend the helper surface**

Update `docker/deno-worker/druvia-helper.ts` so `DruviaWorkerHelper` exposes:

```ts
storage: {
  upload(input: {
    bucket: string
    path: string
    data: Uint8Array | ArrayBuffer | Blob
    contentType: string
  }): Promise<{
    path: string
    publicUrl: string | null
    object: Record<string, unknown>
  }>
  remove(input: {
    bucket: string
    path: string
    ignoreMissing?: boolean
  }): Promise<{
    path: string
    deleted: boolean
  }>
}
```

Implementation rules:
- convert binary input to base64 inside helper
- POST to `/api/internal/functions/storage/upload`
- keep `projectId` out of the helper API
- helper must not allow function code to override caller identity
- helper request body must not carry caller identity; caller is recovered from the signed internal token
- only populate `publicUrl` when the target bucket is public; otherwise return `null`
- `remove()` must stay project-bound and token-bound just like `upload()`

- [ ] **Step 3: Make caller context available to the helper**

Update `docker/deno-worker/executor.ts` so `buildContext()` can create the helper with trusted caller context from the invoke payload.

Do not expose platform JWTs, admin secrets, or any project-configured long-lived token.

- [ ] **Step 4: Keep function invocation payload compatible**

Update `apps/api/src/modules/functions/functions.service.ts` only as needed so the worker continues receiving:
- `internalToken`
- `caller`
- `apiBaseUrl`

Avoid broadening the invoke payload beyond what storage helper needs.

- [ ] **Step 5: Run helper and function service tests**

Run:

```bash
pnpm test tests/unit/druvia-helper.test.ts tests/unit/functions-service.test.ts
```

Expected: PASS


### Task 5: Document The New Function Authoring Contract

**Files:**
- Modify: `docs/agent/project-memory.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`
- Modify: `docs/plans/2026-03-26-end-user-storage-upload-design.md`
- Modify: `docs/plans/2026-03-26-end-user-storage-upload-implementation.md`

- [ ] **Step 1: Update project memory**

Document:
- taro-app image upload officially depends on function proxy upload
- `DRUVIA_TOKEN` is not the formal storage model
- new function runtime contract is `druvia.storage.upload()`

- [ ] **Step 2: Update design decisions**

Record the lasting rule:
- end-user image upload Phase 1 uses function internal storage proxy
- platform-level storage write credentials stay server-side

- [ ] **Step 3: Update progress**

Add a milestone note once code lands:
- internal storage upload path exists
- taro-app style upload functions no longer require project secret token
- helper returns `{ path, publicUrl, object }`, while taro-app compatibility functions still map that to `{ path, url }`


### Task 6: Verify Focused Platform Behavior

**Files:**
- Test: `tests/unit/functions-internal-storage.test.ts`
- Test: `tests/unit/druvia-helper.test.ts`
- Test: `tests/unit/functions-service.test.ts`
- Test: `tests/unit/api-app.test.ts`
- Test: `tests/integration/storage.test.ts`

- [ ] **Step 1: Run the focused unit and integration suite**

Run:

```bash
pnpm test \
  tests/unit/functions-internal-storage.test.ts \
  tests/unit/druvia-helper.test.ts \
  tests/unit/functions-service.test.ts \
  tests/unit/api-app.test.ts \
  tests/integration/storage.test.ts
```

Expected:
- all focused tests pass
- no regression in existing internal GraphQL helper tests when run alongside storage helper work

- [ ] **Step 2: Type-check the API**

Run:

```bash
pnpm exec tsc -p apps/api/tsconfig.json --noEmit
```

Expected: PASS

- [ ] **Step 3: Confirm no new migration is required**

Expected:
- no extra migration is needed for Phase 1 audit because `druvia_storage_objects.metadata` already exists

- [ ] **Step 4: Manual verification checklist**

Confirm manually:
- a function using `druvia.storage.upload()` works without `DRUVIA_TOKEN`
- upload remains bound to current project only
- returned payload includes `publicUrl` only for public buckets
- uploaded object metadata records `source_function` and the triggering end-user identity when caller is `project_user`
- same-path re-upload updates audit metadata instead of leaving stale caller/function values

- [ ] **Step 5: Commit**

```bash
git add \
  apps/api/src/index.ts \
  apps/api/src/modules/functions/internal-storage.routes.ts \
  apps/api/src/modules/functions/internal-token.ts \
  apps/api/src/modules/functions/functions.service.ts \
  apps/api/src/modules/storage/storage.controller.ts \
  apps/api/src/modules/storage/storage.service.ts \
  docker/deno-worker/druvia-helper.ts \
  docker/deno-worker/executor.ts \
  tests/unit/functions-internal-storage.test.ts \
  tests/unit/druvia-helper.test.ts \
  tests/unit/functions-service.test.ts \
  tests/unit/api-app.test.ts \
  tests/integration/storage.test.ts \
  docs/agent/project-memory.md \
  docs/agent/design-decisions.md \
  docs/progress.md \
  docs/plans/2026-03-26-end-user-storage-upload-design.md \
  docs/plans/2026-03-26-end-user-storage-upload-implementation.md
git commit -m "feat(storage): add internal function upload path for end-user images"
```
