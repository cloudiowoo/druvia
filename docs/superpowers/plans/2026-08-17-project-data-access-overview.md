# Project Data Access Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only project data access overview for the default schema, with accurate scoped configuration, Realtime, legacy and review status plus direct navigation to table-level configuration.

**Architecture:** Extract Batch 2A metadata recognition into one actor-aware pure inspector, add a side-effect-free PostgreSQL inventory reader, and compose one project overview from that inventory plus one Hasura metadata export. A dedicated Admin presentation model owns labels, filters and links; the page remains read-only and table editing stays in the existing table detail view.

**Tech Stack:** TypeScript, Fastify 5, PostgreSQL 17, Hasura Metadata API, Next.js 16, React 19, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-08-17-project-data-access-overview-design.md`

**Execution constraint:** Work directly in the main checkout, do not create a worktree or subagent, and do not commit automatically. The user reviews and commits the completed batch.

---

### Task 1: Actor-Aware Metadata Inspection

**Files:**
- Create: `apps/api/src/modules/data-access/data-access-inspection.ts`
- Modify: `apps/api/src/modules/data-access/data-access.service.ts`
- Test: `tests/unit/data-access-inspection.test.ts`
- Test: `tests/unit/data-access-service.test.ts`

- [x] **Step 1: Write failing inspection tests**

Test the public pure inspector with exact metadata fixtures. Verify that it:

- parses supported authenticated and anonymous permissions into the existing logical policy;
- returns separate `authenticatedState` and `anonymousState` values;
- marks an anonymous write as anonymous custom without marking authenticated access custom;
- detects conflicting authenticated owner columns as authenticated custom;
- returns internal legacy roles and existing managed operations for safe replacement;
- accepts Hasura-normalized defaults but rejects wildcard writes, presets and extra fields.

- [x] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm test tests/unit/data-access-inspection.test.ts tests/unit/data-access-service.test.ts
```

Expected: the new test fails because `data-access-inspection.ts` does not exist.

- [x] **Step 3: Extract the pure inspector**

Create this internal result contract:

```typescript
export interface InspectedTableDataAccess {
  authenticatedState: 'managed' | 'custom'
  anonymousState: 'managed' | 'custom'
  policy: TableDataAccessInput
  legacyRoles: string[]
  existingManaged: Array<{ operation: DataAccessOperation; role: string }>
}
```

Move permission-shape recognition from `data-access.service.ts` into the new module. Keep the existing editor behavior by mapping either actor's custom state to `managedState='custom'`. Preserve `bulk_atomic` replacement and all Batch 2A safety rules.

- [x] **Step 4: Run tests and verify GREEN**

Run the Task 1 command again. Expected: inspection and existing service tests pass.

### Task 2: Side-Effect-Free Project Inventory

**Files:**
- Create: `apps/api/src/modules/data-access/data-access-inventory.ts`
- Test: `tests/unit/data-access-inventory.test.ts`

- [x] **Step 1: Write failing inventory tests**

Mock the database query helper and verify:

- visible base tables are returned in table-name order with ordered column names;
- internal `_` tables are excluded by the SQL contract;
- existing `_meta_tables` values map to `realtimeEnabled`;
- a missing `_meta_tables` relation returns all visible tables with `realtimeEnabled=false`;
- no SQL statement creates or alters a table.

Target shape:

```typescript
export interface DataAccessInventoryTable {
  tableName: string
  columns: string[]
  realtimeEnabled: boolean
}
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm test tests/unit/data-access-inventory.test.ts
```

Expected: FAIL because the inventory module does not exist.

- [x] **Step 3: Implement the reader**

Validate the schema identifier. Check `_meta_tables` with `to_regclass`, then run one grouped `information_schema.tables + information_schema.columns` query, with a LEFT JOIN to `_meta_tables` only when it exists. Do not call `ensureRealtimeMetaTable`, track tables or mutate metadata.

- [x] **Step 4: Run the test and verify GREEN**

Run the Task 2 test. Expected: all inventory tests pass.

### Task 3: Overview Aggregation And Management Route

**Files:**
- Create: `apps/api/src/modules/data-access/data-access-overview.ts`
- Modify: `apps/api/src/modules/data-access/data-access.types.ts`
- Modify: `apps/api/src/modules/data-access/data-access.service.ts`
- Modify: `apps/api/src/modules/data-access/data-access.controller.ts`
- Modify: `apps/api/src/modules/data-access/data-access.routes.ts`
- Test: `tests/unit/data-access-overview.test.ts`
- Test: `tests/unit/data-access-controller.test.ts`
- Test: `tests/unit/api-app.test.ts`

- [x] **Step 1: Write failing overview tests**

Test pure aggregation for:

- connected and untracked tables;
- authenticated `closed/read_only/write_only/read_write/custom`;
- anonymous `closed/read/custom`;
- Realtime `disabled/access_required/configured`;
- logical legacy booleans without public role names;
- review flags and non-overlapping summary counts;
- stable table-name ordering;
- `runtimeMode='compatibility'`.

Also test orchestration performs exactly one `export_metadata`, and controller tests cover platform access, `401/403/404/502/500` plus error-message sanitization.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm test \
  tests/unit/data-access-overview.test.ts \
  tests/unit/data-access-controller.test.ts \
  tests/unit/api-app.test.ts
```

Expected: FAIL because overview types, service and route do not exist.

- [x] **Step 3: Implement aggregation and orchestration**

Add `ProjectDataAccessOverview` and row/status types matching the approved spec. Implement a pure builder that receives inventory rows, default-source table metadata and scoped roles. Add `getProjectDataAccessOverview(projectId)` to load the project, inventory and one metadata snapshot, then build the response.

Register:

```text
GET /api/v1/projects/:projectId/data-access/overview
```

Reuse the existing JWT-only project-access guard and sanitized error mapping. Accept no environment input.

- [x] **Step 4: Run tests and verify GREEN**

Run the Task 3 command. Expected: overview, controller and route tests pass.

### Task 4: Admin Contract, Filters And Default-Scope Navigation

**Files:**
- Modify: `apps/admin/src/lib/api.ts`
- Create: `apps/admin/src/lib/project-data-access-overview.ts`
- Modify: `apps/admin/src/lib/table-data-access.ts`
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/page.tsx`
- Test: `tests/unit/admin/project-data-access-overview.test.ts`
- Test: `tests/unit/admin/table-data-access.test.ts`

- [x] **Step 1: Write failing presentation tests**

Verify:

- Chinese status labels for every overview state;
- filters implement the exact `全部/待配置/匿名已配置/Realtime 待授权/需检查` rules;
- untracked, legacy and custom rows do not also enter `待配置`;
- configuration links encode tenant/project/table segments and append `tab=access&scope=default`;
- query resolution accepts only known tab/scope values;
- explicit default scope selects the project schema while ordinary non-default context keeps the access tab closed.

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm test \
  tests/unit/admin/project-data-access-overview.test.ts \
  tests/unit/admin/table-data-access.test.ts
```

Expected: FAIL because the overview presentation module and query resolver do not exist.

- [x] **Step 3: Implement the Admin model and route handling**

Add typed `getProjectDataAccessOverview(projectId)` to `ApiClient`. Add pure helpers for labels, filters, summary display and encoded links. Extend the table detail page to read `tab` and `scope`; `scope=default` normalizes `currentEnv` to the project's production schema before allowing the access tab. Invalid/non-default requests fall back to structure.

- [x] **Step 4: Run tests and verify GREEN**

Run the Task 4 command. Expected: all presentation tests pass.

### Task 5: Read-Only Admin Overview Page

**Files:**
- Create: `apps/admin/src/components/data-access/ProjectDataAccessOverview.tsx`
- Create: `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/data-access/page.tsx`
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/page.tsx`
- Test: `tests/unit/admin/project-data-access-overview-panel.test.tsx`

- [x] **Step 1: Write failing component tests**

Render the presentational component with fixture data and verify:

- compact summary values and compatibility notice;
- all table columns use application-facing Chinese labels;
- filter changes hide and show the correct rows;
- custom, legacy and untracked rows show restrained review status;
- no Hasura, metadata or physical role text is rendered;
- empty-project and filtered-empty states;
- failure state invokes retry;
- configuration action uses the encoded default-scope link.

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm test tests/unit/admin/project-data-access-overview-panel.test.tsx
```

Expected: FAIL because the overview component does not exist.

- [x] **Step 3: Implement the component and page**

Build one unframed page with a compact bordered summary band, segmented filter tabs and one responsive status table. Use existing UI primitives and Lucide icons. Add loading, retry, empty and filtered-empty states. Add the `数据访问` row under project settings and keep the environment switch disabled through `DashboardLayout isProjectLevel`.

- [x] **Step 4: Run tests, lint and Admin build**

Run:

```bash
pnpm test \
  tests/unit/admin/project-data-access-overview.test.ts \
  tests/unit/admin/project-data-access-overview-panel.test.tsx \
  tests/unit/admin/table-data-access.test.ts
cd apps/admin && pnpm exec eslint \
  'src/app/t/[tenantId]/p/[projectId]/settings/data-access/page.tsx' \
  'src/app/t/[tenantId]/p/[projectId]/tables/[tableName]/page.tsx' \
  src/components/data-access/ProjectDataAccessOverview.tsx \
  src/lib/project-data-access-overview.ts \
  src/lib/table-data-access.ts \
  src/lib/api.ts
cd ../.. && pnpm --filter @druvia/admin build
```

Expected: tests and lint pass, and Admin production build exits 0.

### Task 6: Documentation, Review And Verification

**Files:**
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`
- Modify: `docs/superpowers/specs/2026-08-17-project-data-access-design.md`
- Modify: `docs/superpowers/specs/2026-08-17-project-data-access-overview-design.md`

- [x] **Step 1: Record the Batch 2B boundary**

Document the read-only overview, product-facing runtime mode, actor-specific custom classification, default-scope navigation and the fact that scoped permissions remain inactive until Batch 3.

- [x] **Step 2: Run focused verification**

Run:

```bash
pnpm test \
  tests/unit/data-scope-role.test.ts \
  tests/unit/data-access-policy.test.ts \
  tests/unit/data-access-inspection.test.ts \
  tests/unit/data-access-inventory.test.ts \
  tests/unit/data-access-overview.test.ts \
  tests/unit/data-access-service.test.ts \
  tests/unit/data-access-controller.test.ts \
  tests/unit/api-app.test.ts \
  tests/unit/admin/table-data-access.test.ts \
  tests/unit/admin/table-data-access-panel.test.tsx \
  tests/unit/admin/project-data-access-overview.test.ts \
  tests/unit/admin/project-data-access-overview-panel.test.tsx
pnpm --filter @druvia/api build
pnpm --filter @druvia/admin build
git diff --check
```

Expected: all focused tests and both builds pass; diff check reports no whitespace errors.

- [x] **Step 3: Review until no important findings remain**

Review actor isolation, raw-role leakage, one-export behavior, missing metadata-table behavior, default-scope navigation, filter overlap, empty/error states and document drift. Add a failing regression test before every behavioral correction. Keep all changes uncommitted for user review.
