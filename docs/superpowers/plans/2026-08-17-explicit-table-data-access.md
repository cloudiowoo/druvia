# Explicit Table Data Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, application-facing table access editor that materializes safe project-scoped Hasura permissions for the default production data scope.

**Architecture:** A focused `data-access` module owns logical policy validation, scoped-role resolution, metadata inspection and permission replacement. The public management API exposes business actors and row modes rather than Hasura roles. The table detail page edits authenticated CRUD and anonymous read policies through constrained presets; legacy roles, non-production environments and actor cutover remain untouched.

**Tech Stack:** TypeScript, Fastify 5, Hasura metadata API, Next.js 16, React 19, Vitest

**Spec:** `docs/superpowers/specs/2026-08-17-project-data-access-design.md`

**Execution constraint:** Work directly in the main checkout, do not create a worktree or subagent, and do not commit automatically. The user reviews and commits the completed batch.

---

### Task 1: Logical Policy Contract And Materializer

**Files:**
- Create: `apps/api/src/modules/data-access/data-access.types.ts`
- Create: `apps/api/src/modules/data-access/data-access-policy.ts`
- Test: `tests/unit/data-access-policy.test.ts`

- [x] **Step 1: Write failing policy tests**

Define tests for the supported logical contract:

```typescript
type AuthenticatedAccessMode = 'none' | 'all' | 'owner'

interface TableDataAccessInput {
  authenticated: {
    select: AuthenticatedAccessMode
    insert: AuthenticatedAccessMode
    update: AuthenticatedAccessMode
    delete: AuthenticatedAccessMode
    ownerColumn: string | null
  }
  anonymous: { select: boolean }
}
```

Verify that `owner` generates `X-Hasura-User-Id` row filters, insert presets and write-column exclusion for the owner field. Verify that `all` uses `{}`, `none` emits no permission, anonymous never emits write permissions, and owner mode without a valid owner column fails validation.

- [x] **Step 2: Run the test and verify RED**

Run: `pnpm test tests/unit/data-access-policy.test.ts`

Expected: FAIL because the policy materializer does not exist.

- [x] **Step 3: Implement the pure materializer**

Create pure helpers that receive the logical input, physical scoped roles and actual table columns. Return normalized Hasura permission descriptions without making network requests.

Rules:

- `select owner`: `filter: { [ownerColumn]: { _eq: 'X-Hasura-User-Id' } }`, all columns;
- `insert owner`: same `check`, `set: { [ownerColumn]: 'X-Hasura-User-Id' }`, writable columns exclude owner;
- `update owner`: same `filter` and `check`, writable columns exclude owner;
- `delete owner`: same `filter`;
- `all`: empty filter/check and all applicable columns;
- `none`: no permission command;
- anonymous: select only, with an empty filter when enabled.

- [x] **Step 4: Run the test and verify GREEN**

Run: `pnpm test tests/unit/data-access-policy.test.ts`

Expected: all policy tests PASS.

### Task 2: Metadata Read And Atomic Scoped Permission Replacement

**Files:**
- Create: `apps/api/src/modules/data-access/data-access.service.ts`
- Test: `tests/unit/data-access-service.test.ts`

- [x] **Step 1: Write failing service tests**

Mock project lookup, table metadata and Hasura metadata calls. Verify:

- GET resolves only `druvia_v1_s_<hash>_user` and `druvia_v1_s_<hash>_anon` for the target project;
- legacy `user`, `anonymous` and unrelated scoped roles are reported separately and never treated as managed policy;
- PUT tracks the table first, then sends one metadata `bulk` request containing only required drops and creates for the two managed roles;
- no anonymous insert/update/delete command can be generated;
- custom permission shapes for the managed scoped role return `managedState: 'custom'` and PUT refuses to overwrite them with HTTP-facing conflict semantics;
- missing project, missing schema, missing table and invalid owner column are explicit failures.

- [x] **Step 2: Run the service test and verify RED**

Run: `pnpm test tests/unit/data-access-service.test.ts`

Expected: FAIL because `data-access.service.ts` does not exist.

- [x] **Step 3: Implement metadata inspection and replacement**

Use `getProjectById`, `getTableMetadata`, `resolveDataScopeRole` and `hasuraMetadataRequest`.

Return this management shape:

```typescript
interface TableDataAccessState {
  projectId: string
  schemaName: string
  tableName: string
  columns: string[]
  policy: TableDataAccessInput
  managedState: 'managed' | 'custom'
  legacyRoles: string[]
}
```

Inspect `export_metadata`, map only exact supported permission shapes back to logical modes, and preserve all unrelated roles. PUT must reject `custom` managed-role metadata rather than silently replacing it. Build a single Hasura `bulk` request from existing managed permission operations and desired operations.

- [x] **Step 4: Run service tests and verify GREEN**

Run: `pnpm test tests/unit/data-access-service.test.ts`

Expected: all service tests PASS.

### Task 3: JWT-Only Project Management Routes

**Files:**
- Create: `apps/api/src/modules/data-access/data-access.controller.ts`
- Create: `apps/api/src/modules/data-access/data-access.routes.ts`
- Modify: `apps/api/src/index.ts`
- Test: `tests/unit/data-access-controller.test.ts`
- Test: `tests/unit/api-app.test.ts`

- [x] **Step 1: Write failing controller and route tests**

Cover:

- platform users with project access can GET and PUT;
- platform users without access receive `403`;
- project-user JWT and project API keys receive `401` on management routes;
- invalid policy input receives `400`;
- custom managed metadata conflict receives `409`;
- service/Hasura failure receives `502` without exposing admin secret values.

Endpoints:

```text
GET /api/v1/projects/:projectId/data-access/tables/:tableName
PUT /api/v1/projects/:projectId/data-access/tables/:tableName
```

- [x] **Step 2: Run tests and verify RED**

Run: `pnpm test tests/unit/data-access-controller.test.ts tests/unit/api-app.test.ts`

Expected: FAIL because routes are not registered.

- [x] **Step 3: Implement routes and validation**

Use `authenticate`, require `request.user.kind === 'platform_user'`, call `checkProjectAccess`, and validate the finite mode values plus nullable owner column before calling the service. Do not accept `env` in Batch 2A; the endpoint manages the default project schema only.

- [x] **Step 4: Run tests and verify GREEN**

Run: `pnpm test tests/unit/data-access-controller.test.ts tests/unit/api-app.test.ts`

Expected: route and controller tests PASS.

### Task 4: Admin API Contract And Presentation Model

**Files:**
- Modify: `apps/admin/src/lib/api.ts`
- Create: `apps/admin/src/lib/table-data-access.ts`
- Test: `tests/unit/admin/table-data-access.test.ts`

- [x] **Step 1: Write failing presentation tests**

Test labels and risk state without importing page components:

- `none -> 关闭`;
- `all -> 全部记录`;
- `owner -> 仅自己的记录`;
- any authenticated write operation set to `all` returns a high-risk warning;
- owner mode requires an owner column;
- anonymous state exposes only a read switch.

- [x] **Step 2: Run test and verify RED**

Run: `pnpm test tests/unit/admin/table-data-access.test.ts`

Expected: FAIL because the presenter does not exist.

- [x] **Step 3: Add typed API methods and pure UI helpers**

Add `getTableDataAccess(projectId, tableName)` and `updateTableDataAccess(projectId, tableName, policy)` to `ApiClient`. Keep the response type aligned with the API service state and expose no physical role name.

- [x] **Step 4: Run test and verify GREEN**

Run: `pnpm test tests/unit/admin/table-data-access.test.ts`

Expected: all presentation tests PASS.

### Task 5: Table-Level Data Access Editor

**Files:**
- Create: `apps/admin/src/components/tables/TableDataAccessPanel.tsx`
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/page.tsx`
- Test: `tests/unit/admin/table-data-access-panel.test.tsx`

- [x] **Step 1: Write failing panel tests**

Test the pure state transitions or rendered panel behavior for:

- loading existing policy;
- changing authenticated operation modes;
- showing owner-field selection when any operation uses `owner`;
- anonymous controls containing only a read switch;
- disabling save for invalid owner configuration or `managedState='custom'`;
- successful save refresh and destructive error toast.

- [x] **Step 2: Run panel tests and verify RED**

Run: `pnpm test tests/unit/admin/table-data-access-panel.test.tsx`

Expected: FAIL because the panel does not exist.

- [x] **Step 3: Implement the editor**

Add `表结构` and `数据访问` tabs to the table detail page. The data-access panel uses four compact authenticated operation rows with Select controls, one owner-column Select when required, and an anonymous read Switch. Display a restrained warning when unrestricted writes are selected. Do not display Hasura, metadata command names, physical roles or secrets.

Only show the editor for the production/default project scope. For a selected non-production environment, render the tab disabled so the UI cannot configure a scope that the runtime does not yet authenticate.

- [x] **Step 4: Run tests, lint and Admin build**

Run:

```bash
pnpm test tests/unit/admin/table-data-access.test.ts tests/unit/admin/table-data-access-panel.test.tsx
cd apps/admin && pnpm exec eslint \
  'src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/page.tsx' \
  src/components/tables/TableDataAccessPanel.tsx \
  src/lib/table-data-access.ts
cd ../.. && pnpm --filter @druvia/admin build
```

Expected: tests PASS, changed-file lint has zero errors, and Admin build exits 0.

### Task 6: Documentation, Review And Batch Verification

**Files:**
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`
- Modify: `docs/superpowers/specs/2026-08-17-project-data-access-design.md`

- [x] **Step 1: Record the Batch 2A boundary**

Document:

- only default production data scope is editable;
- authenticated CRUD supports `none/all/owner` presets;
- anonymous is select-only in the simplified editor;
- managed scoped roles are materialized but not activated for HTTP/WebSocket until Batch 3;
- legacy roles and custom scoped metadata are preserved;
- project overview and legacy migration preview remain Batch 2B/Batch 4.

- [x] **Step 2: Run focused verification**

Run:

```bash
pnpm test \
  tests/unit/data-scope-role.test.ts \
  tests/unit/data-access-policy.test.ts \
  tests/unit/data-access-service.test.ts \
  tests/unit/data-access-controller.test.ts \
  tests/unit/admin/table-data-access.test.ts \
  tests/unit/admin/table-data-access-panel.test.tsx
pnpm --filter @druvia/api build
pnpm --filter @druvia/admin build
git diff --check
```

Expected: focused tests and builds PASS; diff check has no whitespace errors.

- [x] **Step 3: Review until no important findings remain**

Review metadata preservation, cross-project access, anonymous writes, owner-column validation, partial metadata failure, Admin state transitions and document drift. Add a failing regression test before each behavioral fix, rerun focused verification after fixes, and leave the worktree uncommitted for user review.
