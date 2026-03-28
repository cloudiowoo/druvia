# Project Session And Storage Trusted Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared trusted-backend foundation so external apps can obtain standard project sessions for existing project users and issue constrained storage tickets for upload/remove, without inventing a second auth system.

**Architecture:** Add a project-scoped `trusted backend key` model with scopes, then implement two issuer layers on top of it: `project session trusted issuer` and `storage trusted ticket issuer`. Reuse existing `project-auth.service.ts` session issuance for identity, and add storage ticket consume routes for capability. Keep taro-app’s current Edge Function upload path intact.

**Tech Stack:** Fastify 5, Node.js 22, PostgreSQL 17, jsonwebtoken, Next.js 16, Vitest, `@druvia/sdk`

**Spec:** `docs/plans/2026-03-28-project-session-and-storage-trusted-access-design.md`

---

## File Structure

### Trusted backend foundation

- Create: `migrations/017_trusted_backend_access.up.sql`
- Create: `migrations/017_trusted_backend_access.down.sql`
- Create: `apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.service.ts`
- Create: `apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.routes.ts`
- Modify: `apps/api/src/index.ts`

Responsibility:
- define project-scoped trusted backend keys
- add scope-aware validation
- keep them separate from anonymous `apikey`

### Trusted session issuer

- Modify: `apps/api/src/modules/project-auth/project-auth.service.ts`
- Modify: `apps/api/src/modules/project-auth/project-auth.routes.ts`
- Modify: `apps/api/src/modules/project-auth/project-auth.controller.ts`
- Modify: `packages/sdk/src/modules/project-auth.ts`
- Create: `tests/unit/project-auth.trusted-issuer.test.ts`
- Modify: `tests/sdk/project-auth.test.ts`

Responsibility:
- reuse `issueProjectSession()` for existing project users
- expose trusted issuer route
- avoid duplicating refresh/logout semantics
- ensure trusted-issued sessions still complete refresh/logout through the existing lifecycle

### Trusted storage access

- Create: `apps/api/src/modules/storage/storage-trusted-access.service.ts`
- Modify: `apps/api/src/modules/storage/storage.controller.ts`
- Modify: `apps/api/src/modules/storage/storage.routes.ts`
- Modify: `apps/api/src/modules/storage/storage.service.ts`
- Modify: `apps/api/src/config/index.ts` if dedicated secrets are needed

Responsibility:
- issue upload/remove ticket
- validate and consume ticket
- persist storage audit metadata

### SDK

- Modify: `packages/sdk/src/modules/project-auth.ts`
- Modify: `packages/sdk/src/modules/storage.ts`
- Modify: `packages/sdk/src/DruviaClient.ts`
- Modify: `packages/sdk/src/types.ts`
- Modify: `tests/sdk/project-auth.test.ts`
- Modify: `tests/sdk/storage.test.ts`

Responsibility:
- add trusted session helper
- add trusted storage ticket helper
- keep existing client behavior stable

### Admin

- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/api-keys/page.tsx`
- Modify: `apps/admin/src/lib/api.ts`

Responsibility:
- manage trusted backend keys
- expose key scopes
- keep UI separate from anonymous API keys

### Docs and memory

- Modify: `docs/agent/project-memory.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`

Responsibility:
- capture long-lived rules for H5/taro-app migration
- record that Phase 1 trusted issuer/storage auditing is stdout-first structured logging, not a new audit table

---

### Task 1: Add Trusted Backend Key Foundation With Scopes

**Files:**
- Create: `migrations/017_trusted_backend_access.up.sql`
- Create: `migrations/017_trusted_backend_access.down.sql`
- Create: `apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.service.ts`
- Create: `tests/integration/trusted-backend-keys.test.ts`

- [ ] **Step 1: Write the failing integration test**

Cover:

- create trusted backend key returns one-time full secret
- list hides full secret
- validate accepts trusted backend key
- validate rejects normal anonymous `apikey`
- scope checks work
- delete is project-scoped

Run:

```bash
pnpm test tests/integration/trusted-backend-keys.test.ts
```

Expected: FAIL because the table and service do not exist yet.

- [ ] **Step 2: Add the database table**

Create `druvia_trusted_backend_keys` with:

- `project_id`
- `key_hash`
- `key_prefix`
- `name`
- `scopes text[] not null`
- `created_by`
- `last_used_at`
- `created_at`

Recommended minimum scopes:

- `project_session:issue`
- `storage_ticket:issue`

- [ ] **Step 3: Implement the service**

Implement:

- `createTrustedBackendKey(projectId, input)`
- `listTrustedBackendKeys(projectId)`
- `deleteTrustedBackendKey(id, projectId)`
- `validateTrustedBackendKey(key, requiredScope?)`

Rules:

- distinct key prefix, for example `drutb_`
- hash-at-rest only
- successful validation updates `last_used_at`
- required scope enforcement happens centrally here

- [ ] **Step 4: Run the integration test**

Run:

```bash
pnpm test tests/integration/trusted-backend-keys.test.ts
```

Expected: PASS


### Task 2: Add Admin/API Management For Trusted Backend Keys

**Files:**
- Create: `apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.routes.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/admin/src/lib/api.ts`
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/api-keys/page.tsx`

- [ ] **Step 1: Add route coverage**

Assert:

- `GET /api/v1/projects/:projectId/trusted-backend-keys`
- `POST /api/v1/projects/:projectId/trusted-backend-keys`
- `DELETE /api/v1/projects/:projectId/trusted-backend-keys/:keyId`

Run:

```bash
pnpm test tests/unit/api-app.test.ts
```

Expected: FAIL because the routes are missing.

- [ ] **Step 2: Implement API routes**

Use platform JWT + `checkProjectAccess()` for admin management routes.

Create body should support:

```json
{
  "name": "H5 Backend",
  "scopes": ["project_session:issue", "storage_ticket:issue"]
}
```

- [ ] **Step 3: Extend Admin UI**

On `settings/api-keys/page.tsx`:

- keep anonymous API Keys section as-is
- add a second `Trusted Backend Keys` section
- allow choosing scopes on create
- show one-time secret only on create

- [ ] **Step 4: Manual verify**

Verify:

- create trusted key with one scope
- create trusted key with both scopes
- list only shows metadata and scopes
- anonymous API key section still works


### Task 3: Add Project Session Trusted Issuer

**Files:**
- Modify: `apps/api/src/modules/project-auth/project-auth.service.ts`
- Modify: `apps/api/src/modules/project-auth/project-auth.routes.ts`
- Modify: `apps/api/src/modules/project-auth/project-auth.controller.ts`
- Modify: `packages/sdk/src/modules/project-auth.ts`
- Create: `tests/unit/project-auth.trusted-issuer.test.ts`
- Modify: `tests/unit/functions-controller.test.ts`
- Modify: `tests/unit/rpc-controller.test.ts`

- [ ] **Step 1: Write the failing trusted issuer tests**

Cover:

- trusted backend key with `project_session:issue` can issue session for existing user
- trusted backend key without that scope is rejected
- unknown `userId` is rejected
- route does not accept anonymous `apikey`
- returned payload matches normal `ProjectSession`
- trusted-issued session can still refresh through the existing `/auth/refresh`
- trusted-issued session can still logout through the existing `/auth/logout`
- trusted-issued session access token is accepted by existing same-project function/RPC auth checks

Run:

```bash
pnpm test tests/unit/project-auth.trusted-issuer.test.ts
```

Expected: FAIL because the trusted issuer route does not exist yet.

- [ ] **Step 2: Reuse existing project auth core**

In `project-auth.service.ts`, extract or expose a focused helper for:

- load project context
- verify project user exists by `userId`
- call existing `issueProjectSession()`

Do not duplicate token minting logic.

- [ ] **Step 3: Add the trusted issuer route**

Add:

- `POST /api/v1/projects/:projectId/auth/trusted/issue-session`

It must:

- read `x-druvia-trusted-backend-key`
- validate scope `project_session:issue`
- require key project to match route project
- accept body `{ userId: string }`

- [ ] **Step 4: Fix trusted-issued session lifecycle gaps**

Current code already exposes:

- `POST /projects/:projectId/auth/refresh`
- `POST /projects/:projectId/auth/logout`

Trusted issuer only counts as complete if those lifecycle paths still work for the newly issued session.

Explicitly verify and fix:

- SDK `projectAuth.logout()` sends the current Bearer access token
- logout continues to require same-project `project_user`
- trusted-issued session refresh/logout do not introduce a second parallel API shape
- a token produced by trusted issuer remains compatible with existing same-project function/RPC authorization branches

- [ ] **Step 5: Add stdout-first issuer audit logs**

At minimum, emit structured logs for trusted session issuance with:

- `projectId`
- `trustedKeyPrefix` or equivalent identifier
- `issuerScope = project_session:issue`
- `projectUserId`
- `issuedAt`
- `sourceIp`
- `userAgent`

Use the existing structured logging direction, not a new audit table.

- [ ] **Step 6: Run the trusted issuer tests**

Run:

```bash
pnpm test tests/unit/project-auth.trusted-issuer.test.ts tests/unit/functions-controller.test.ts tests/unit/rpc-controller.test.ts tests/sdk/project-auth.test.ts
```

Expected: PASS for trusted issuer coverage.


### Task 4: Add SDK Trusted Session Helper

**Files:**
- Modify: `packages/sdk/src/modules/project-auth.ts`
- Modify: `packages/sdk/src/DruviaClient.ts`
- Modify: `tests/sdk/project-auth.test.ts`

- [ ] **Step 1: Add failing SDK test**

Cover:

- `projectAuth.issueTrustedSession({ userId, trustedBackendKey })`
- request posts to `/projects/:projectId/auth/trusted/issue-session`
- request sends `x-druvia-trusted-backend-key`

Run:

```bash
pnpm test tests/sdk/project-auth.test.ts
```

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 2: Implement the helper**

Keep the new helper inside `projectAuth`, not `auth`, so the identity split stays explicit.

- [ ] **Step 3: Run the SDK test**

Run:

```bash
pnpm test tests/sdk/project-auth.test.ts
```

Expected: PASS


### Task 5: Add Storage Trusted Ticket Service

**Files:**
- Create: `apps/api/src/modules/storage/storage-trusted-access.service.ts`
- Create: `tests/unit/storage-trusted-access.service.test.ts`
- Modify: `apps/api/src/config/index.ts` if needed

- [ ] **Step 1: Write the failing service tests**

Cover:

- `issueUploadTicket()` rejects unknown user
- `issueUploadTicket()` rejects unknown bucket
- `issueUploadTicket()` validates `pathPrefix`
- `issueUploadTicket()` enforces TTL cap
- `issueRemoveTicket()` requires exact path
- verify helpers reject expired or tampered ticket

Run:

```bash
pnpm test tests/unit/storage-trusted-access.service.test.ts
```

Expected: FAIL because the service does not exist yet.

- [ ] **Step 2: Implement signed ticket helpers**

Add:

- `issueUploadTicket()`
- `verifyUploadTicket()`
- `issueRemoveTicket()`
- `verifyRemoveTicket()`

Ticket claims should include:

- `purpose`
- `projectId`
- `projectUserId`
- `bucket`
- `pathPrefix` or `path`
- `contentTypes`
- `maxBytes`
- `issuedBy`
- `iat`
- `exp`

- [ ] **Step 3: Run the unit test**

Run:

```bash
pnpm test tests/unit/storage-trusted-access.service.test.ts
```

Expected: PASS


### Task 6: Add Trusted Storage Issuer Routes

**Files:**
- Modify: `apps/api/src/modules/storage/storage.controller.ts`
- Modify: `apps/api/src/modules/storage/storage.routes.ts`
- Create: `tests/integration/storage-trusted-access.test.ts`

- [ ] **Step 1: Write the failing issuer integration tests**

Cover:

- trusted backend key with `storage_ticket:issue` can issue upload ticket
- trusted backend key with `storage_ticket:issue` can issue remove ticket
- wrong-scope trusted key is rejected
- wrong-project trusted key is rejected
- anonymous `apikey` is rejected
- unknown `userId` is rejected
- issuer emits structured audit log fields

Run:

```bash
pnpm test tests/integration/storage-trusted-access.test.ts
```

Expected: FAIL because the issuer routes do not exist yet.

- [ ] **Step 2: Add issuer routes**

Add:

- `POST /api/v1/projects/:projectId/storage/trusted/upload-ticket`
- `POST /api/v1/projects/:projectId/storage/trusted/remove-ticket`

These must:

- read `x-druvia-trusted-backend-key`
- validate scope `storage_ticket:issue`
- require trusted key project match
- accept narrow request body

- [ ] **Step 3: Add stdout-first storage issuer audit logs**

For both upload-ticket and remove-ticket issuance, emit structured logs with:

- `projectId`
- `trustedKeyPrefix` or equivalent identifier
- `issuerScope = storage_ticket:issue`
- `projectUserId`
- `bucket`
- `pathPrefix` or `path`
- `issuedAt`
- `sourceIp`
- `userAgent`

- [ ] **Step 4: Run the integration tests**

Run:

```bash
pnpm test tests/integration/storage-trusted-access.test.ts
```

Expected: PASS for issuer coverage.


### Task 7: Add Ticket Consumption Routes For Upload And Remove

**Files:**
- Modify: `apps/api/src/modules/storage/storage.controller.ts`
- Modify: `apps/api/src/modules/storage/storage.routes.ts`
- Modify: `apps/api/src/modules/storage/storage.service.ts`
- Modify: `tests/integration/storage.test.ts`
- Modify: `tests/integration/storage-trusted-access.test.ts`

- [ ] **Step 1: Extend integration tests**

Cover:

- valid upload ticket succeeds
- path outside `pathPrefix` gets `403`
- invalid mime gets `415`
- file too large gets `413`
- expired ticket gets `401`
- valid remove ticket succeeds
- remove outside exact authorized path gets `403`

Also verify metadata:

- `created_by_type = 'trusted_backend_project_user'`
- `created_by_project_user_id`
- `issued_by`
- `issued_via = 'trusted_storage_ticket'`

Run:

```bash
pnpm test tests/integration/storage.test.ts tests/integration/storage-trusted-access.test.ts
```

Expected: FAIL because consume routes and metadata mapping do not exist yet.

- [ ] **Step 2: Add consume routes**

Add:

- `POST /api/v1/storage/upload-with-ticket`
- `POST /api/v1/storage/remove-with-ticket`

These must not use the normal `authenticate` hook.

They must:

- read `x-druvia-storage-ticket`
- verify ticket purpose and scope
- restore `projectId` and `projectUserId` from ticket only

- [ ] **Step 3: Extend storage audit metadata**

Update `StorageUploadAuditContext` to support:

- `trusted_backend_project_user`
- `issuedBy`
- `issuedVia`

Persist these on insert and same-path upsert.

- [ ] **Step 4: Add stdout-first ticket consumption audit logs**

Emit structured logs for:

- successful upload-with-ticket
- rejected upload-with-ticket
- successful remove-with-ticket
- rejected remove-with-ticket

Include at least:

- `projectId`
- `projectUserId`
- `bucket`
- `objectPath`
- `issuedBy`
- `issuedVia = trusted_storage_ticket`
- `usedAt`

- [ ] **Step 5: Run the integration tests**

Run:

```bash
pnpm test tests/integration/storage.test.ts tests/integration/storage-trusted-access.test.ts
```

Expected: PASS


### Task 8: Add SDK Storage Ticket Helpers

**Files:**
- Modify: `packages/sdk/src/modules/storage.ts`
- Modify: `packages/sdk/src/types.ts`
- Modify: `tests/sdk/storage.test.ts`

- [ ] **Step 1: Add failing SDK tests**

Cover:

- `storage.issueUploadTicket({... trustedBackendKey })`
- `storage.issueRemoveTicket({... trustedBackendKey })`
- `storage.uploadWithTicket(ticket, file, { path })`
- `storage.removeWithTicket(ticket, path)`

Run:

```bash
pnpm test tests/sdk/storage.test.ts
```

Expected: FAIL because the helpers do not exist yet.

- [ ] **Step 2: Implement helpers**

Rules:

- issuer helpers send `x-druvia-trusted-backend-key`
- consume helpers send `x-druvia-storage-ticket`
- keep existing `from(bucket)` API stable

- [ ] **Step 3: Run the SDK test**

Run:

```bash
pnpm test tests/sdk/storage.test.ts
```

Expected: PASS


### Task 9: Update Docs And Project Memory

**Files:**
- Modify: `docs/agent/project-memory.md`
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`

- [ ] **Step 1: Record durable rules**

Document:

- `project session` and `storage ticket` are complementary
- H5 should use trusted session issuer for identity
- H5 should prefer storage ticket for uploads
- taro-app can keep current Edge Function upload path for now
- Phase 1 auditing for trusted issuer/storage ticket is structured-log based

- [ ] **Step 2: Update progress**

Capture which modules now own:

- trusted backend foundation
- trusted session issuer
- trusted storage ticket


### Task 10: Final Verification Pass

**Files:**
- No new files

- [ ] **Step 1: Run focused auth/storage integration tests**

```bash
pnpm test tests/integration/trusted-backend-keys.test.ts tests/integration/storage-trusted-access.test.ts tests/integration/storage.test.ts
```

Expected: PASS

- [ ] **Step 2: Run focused SDK tests**

```bash
pnpm test tests/sdk/project-auth.test.ts tests/sdk/storage.test.ts
```

Expected: PASS

- [ ] **Step 3: Run targeted unit tests**

```bash
pnpm test tests/unit/project-auth.trusted-issuer.test.ts tests/unit/functions-controller.test.ts tests/unit/rpc-controller.test.ts tests/unit/storage-trusted-access.service.test.ts tests/unit/functions-internal-storage.test.ts
```

Expected: PASS

- [ ] **Step 4: Manual acceptance checklist**

Verify locally:

- Admin can create trusted backend keys with scopes
- H5-style backend can issue standard project session for existing user
- trusted-issued session can refresh and logout correctly
- trusted-issued session can call one same-project `jwt_required` Function and one RPC successfully
- H5-style backend can issue upload/remove ticket
- upload succeeds only within the authorized prefix/path
- taro-app current upload flow still works unchanged
