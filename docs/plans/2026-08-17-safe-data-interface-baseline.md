# Safe Data Interface Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Druvia from automatically granting broad Hasura permissions, decouple Realtime capability from read permission, and present the resulting state as application data-interface readiness.

**Architecture:** A pure versioned role resolver establishes the future scoped-role contract without cutting existing projects over. Table tracking becomes metadata-only, Realtime toggles only `_meta_tables.realtime_enabled`, and status APIs derive tracking/read/realtime readiness from exported metadata. Admin continues using existing routes but replaces Hasura-centric labels with data-interface language.

**Tech Stack:** TypeScript, Fastify 5, Hasura metadata API, Next.js 16, React 19, Vitest

**Spec:** `docs/plans/2026-08-17-project-data-access-design.md`

---

### Task 1: Versioned Scoped Role Resolver

**Files:**
- Create: `apps/api/src/modules/data-access/data-scope-role.ts`
- Test: `tests/unit/data-scope-role.test.ts`

- [x] **Step 1: Write failing resolver tests**

Test that the resolver is deterministic, separates projects/environments and actors, emits lower-case ASCII, and rejects unsupported actor kinds.

```typescript
import { describe, expect, it } from 'vitest'
import { resolveDataScopeRole } from '../../apps/api/src/modules/data-access/data-scope-role.js'

describe('resolveDataScopeRole', () => {
  it('generates deterministic versioned roles for a project production scope', () => {
    expect(resolveDataScopeRole({ projectId: 'proj_123', actor: 'authenticated' }))
      .toMatch(/^druvia_v1_s_[a-f0-9]{20}_user$/)
    expect(resolveDataScopeRole({ projectId: 'proj_123', actor: 'authenticated' }))
      .toBe(resolveDataScopeRole({ projectId: 'proj_123', actor: 'authenticated' }))
  })

  it('separates anonymous, project and environment scopes', () => {
    const user = resolveDataScopeRole({ projectId: 'proj_123', actor: 'authenticated' })
    const anon = resolveDataScopeRole({ projectId: 'proj_123', actor: 'anonymous' })
    const dev = resolveDataScopeRole({
      projectId: 'proj_123',
      environmentId: 42,
      actor: 'authenticated',
    })

    expect(anon).not.toBe(user)
    expect(dev).not.toBe(user)
  })
})
```

- [x] **Step 2: Run the resolver test and verify RED**

Run: `pnpm test tests/unit/data-scope-role.test.ts`

Expected: FAIL because `data-scope-role.ts` does not exist.

- [x] **Step 3: Implement the minimal resolver**

Create a pure helper using `node:crypto`, SHA-256 and the first 20 hexadecimal characters. Hash `project:<projectId>:prod` for default scope and `project:<projectId>:environment:<environmentId>` for environment scope. Map only `authenticated -> user` and `anonymous -> anon`.

- [x] **Step 4: Run the resolver test and verify GREEN**

Run: `pnpm test tests/unit/data-scope-role.test.ts`

Expected: both tests PASS.

### Task 2: Tracking Must Not Grant Data Access

**Files:**
- Modify: `apps/api/src/modules/table/table.service.ts`
- Modify: `tests/unit/table-service.test.ts`

- [x] **Step 1: Write a failing tracking test**

Add a test that calls `trackTableInHasura('dru_test', 'orders')`, expects `pg_track_table`, and asserts no metadata request type contains `_permission`.

```typescript
it('tracks a table without creating default data permissions', async () => {
  await trackTableInHasura('dru_test', 'orders')

  expect(hasuraMetadataRequest).toHaveBeenCalledWith('pg_track_table', {
    source: 'default',
    table: { schema: 'dru_test', name: 'orders' },
  })
  expect(vi.mocked(hasuraMetadataRequest).mock.calls.some(([type]) =>
    String(type).includes('_permission')
  )).toBe(false)
})
```

- [x] **Step 2: Run the test and verify RED**

Run: `pnpm test tests/unit/table-service.test.ts`

Expected: FAIL because the service currently creates `user` and `anonymous` permissions.

- [x] **Step 3: Remove automatic permission creation**

Change `trackTableInHasura` to perform only `pg_track_table`. Remove the legacy anonymous-select cleanup block from `trackAllTablesInHasura`; synchronization must not mutate any permission.

- [x] **Step 4: Run table-service tests and verify GREEN**

Run: `pnpm test tests/unit/table-service.test.ts`

Expected: all tests PASS.

### Task 3: Realtime Switch Must Not Mutate Permissions

**Files:**
- Modify: `apps/api/src/modules/realtime/realtime.service.ts`
- Create: `tests/unit/realtime-service.test.ts`
- Modify: `tests/integration/realtime.test.ts`

- [x] **Step 1: Write failing Realtime unit tests**

Mock the database query and metadata request. Verify enabling tracks the table and updates `_meta_tables`, but does not create a select permission. Verify disabling updates `_meta_tables` and does not drop a select permission.

```typescript
it('enables realtime without creating select permission', async () => {
  const result = await configureTableSubscription('dru_test', 'events', true)

  expect(result.enabled).toBe(true)
  expect(hasuraMetadataRequest).toHaveBeenCalledWith('pg_track_table', expect.any(Object))
  expect(vi.mocked(hasuraMetadataRequest).mock.calls.some(([type]) =>
    String(type).includes('_permission')
  )).toBe(false)
})
```

- [x] **Step 2: Run the unit test and verify RED**

Run: `pnpm test tests/unit/realtime-service.test.ts`

Expected: FAIL because enable creates and disable drops `anonymous` select permission.

- [x] **Step 3: Remove Realtime permission side effects**

Keep `_meta_tables` upsert. When enabling, retain idempotent table tracking. Remove `REALTIME_ROLE`, `pg_create_select_permission`, and `pg_drop_select_permission` calls. Add a metadata-derived select-access helper in the same change so `hasSelectPermission` is never inferred from `enabled`.

- [x] **Step 4: Update integration expectations**

Change integration assertions so toggling only verifies `_meta_tables.realtime_enabled`; do not require metadata permission creation/deletion.

- [x] **Step 5: Run Realtime tests and verify GREEN**

Run: `pnpm test tests/unit/realtime-service.test.ts tests/integration/realtime.test.ts`

Expected: unit tests PASS; integration tests PASS when integration dependencies are available, otherwise report the dependency failure separately.

### Task 4: Derive Data-Interface And Realtime Readiness

**Files:**
- Modify: `apps/api/src/modules/table/table.service.ts`
- Modify: `apps/api/src/modules/table/table.controller.ts`
- Modify: `apps/api/src/modules/realtime/realtime.service.ts`
- Modify: `apps/admin/src/lib/api.ts`
- Test: `tests/unit/table-service.test.ts`
- Test: `tests/unit/realtime-service.test.ts`

- [x] **Step 1: Write failing status tests**

Define `TableDataAccessStatus` with:

```typescript
interface TableDataAccessStatus {
  tracked: boolean
  selectRoles: string[]
  hasAuthenticatedRead: boolean
  hasAnonymousRead: boolean
}
```

Test legacy role recognition (`user`, `anonymous`) and scoped-role recognition passed as optional expected roles. Test Realtime status values `disabled`, `access_required`, and `ready`.

- [x] **Step 2: Run status tests and verify RED**

Run: `pnpm test tests/unit/table-service.test.ts tests/unit/realtime-service.test.ts`

Expected: FAIL because current status returns only `{ tracked, roles }` and equates Realtime enablement with select permission.

- [x] **Step 3: Implement readiness derivation**

Reuse the metadata-derived role collection added in Task 3 and return explicit authenticated/anonymous read flags. For Batch 1, recognize existing `user`/`anonymous`; accept scoped role names when the caller can resolve them. Because the current SDK WebSocket transport still connects with the Hasura `anonymous` role, Realtime list status reports `ready` only when `realtime_enabled=true` and `anonymous` select permission exists. Authenticated/scoped Realtime readiness is deferred to the Batch 3 Project JWT and short-lived anonymous token cutover.

- [x] **Step 4: Update Admin API types**

Replace the existing `Record<string, { tracked: boolean; roles: string[] }>` type with the explicit status type while keeping the existing endpoint path.

- [x] **Step 5: Run status tests and verify GREEN**

Run: `pnpm test tests/unit/table-service.test.ts tests/unit/realtime-service.test.ts`

Expected: all tests PASS.

### Task 5: Simplify Tables And Realtime UI Language

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/tables/page.tsx`
- Modify: `apps/admin/src/app/t/[tenantId]/p/[projectId]/realtime/page.tsx`
- Create: `tests/unit/admin/data-interface-status.test.tsx`

- [x] **Step 1: Write failing UI tests**

Extract a small status presenter and test these labels:

```typescript
expect(getDataInterfaceLabel({ tracked: false })).toBe('未接入')
expect(getDataInterfaceLabel({ tracked: true, hasAuthenticatedRead: false })).toBe('待配置访问')
expect(getDataInterfaceLabel({ tracked: true, hasAuthenticatedRead: true })).toBe('可用')
expect(getRealtimeLabel({ enabled: true, hasSelectPermission: false })).toBe('待配置读取权限')
```

- [x] **Step 2: Run the presenter test and verify RED**

Run: `pnpm test tests/unit/admin/data-interface-status.test.tsx`

Expected: FAIL because the presenter does not exist.

- [x] **Step 3: Implement user-facing labels and controls**

Use application-facing terms:

- `GraphQL` column -> `Data API`;
- `刷新 Hasura Schema` -> `刷新数据结构`;
- `同步 GraphQL 权限` -> `同步数据接口`;
- toast `Hasura Schema 已刷新` -> `数据结构已刷新`;
- Realtime enabled without read permission -> `待配置读取权限`.

Keep technical role names and metadata operations out of the default view.

- [x] **Step 4: Run UI test and Admin checks**

Run: `pnpm test tests/unit/admin/data-interface-status.test.tsx`

Run the changed-file lint from `apps/admin`:

```bash
pnpm exec eslint \
  'src/app/t/[tenantId]/p/[projectId]/tables/page.tsx' \
  'src/app/t/[tenantId]/p/[projectId]/realtime/page.tsx' \
  src/lib/data-interface-status.ts
```

Run: `pnpm --filter @druvia/admin build`

Expected: test PASS, changed files have no lint errors, and the production build exits 0. Full Admin lint has unrelated baseline errors and is recorded separately.

### Task 6: Documentation And Batch Verification

**Files:**
- Modify: `docs/agent/design-decisions.md`
- Modify: `docs/progress.md`
- Modify: `docs/plans/2026-03-21-realtime-permission-decoupling-design.md`

- [x] **Step 1: Correct superseded decisions**

Mark the old Realtime design as superseded where it states that the switch owns anonymous select permission. Record that tracking and Realtime switches no longer grant data permissions, and that normal Admin UX uses data-access terminology.

- [x] **Step 2: Run focused verification**

Run:

```bash
pnpm test tests/unit/data-scope-role.test.ts tests/unit/table-service.test.ts tests/unit/realtime-service.test.ts tests/unit/admin/data-interface-status.test.tsx
pnpm --filter @druvia/shared build
pnpm --filter @druvia/api build
cd apps/admin && pnpm exec eslint \
  'src/app/t/[tenantId]/p/[projectId]/tables/page.tsx' \
  'src/app/t/[tenantId]/p/[projectId]/realtime/page.tsx' \
  src/lib/data-interface-status.ts
cd ../../ && pnpm --filter @druvia/admin build
git diff --check
```

Expected: all commands exit 0.

- [x] **Step 3: Record remaining rollout boundary**

Update progress to state that Batch 1 establishes safe defaults but does not yet activate scoped HTTP/Realtime roles. Batch 2 must add explicit permission editing before Batch 3 actor cutover.
