# Realtime 权限解耦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Realtime subscription control from Hasura GraphQL permissions by introducing a `realtime_enabled` column in `_meta_tables` and splitting role-based permission management between Tables page (`user` role) and Realtime page (`anonymous` role).

**Architecture:** Tables page manages `user` role permissions (all CRUD). Realtime page manages `anonymous` role's `select_permission` only. GraphQL queries go through API proxy with `admin-secret` (unaffected by role permissions). Subscriptions connect directly to Hasura using `anonymous` role, so controlling `anonymous` select_permission provides real technical enforcement.

**Tech Stack:** PostgreSQL (PL/pgSQL migration), Fastify (API), Hasura CE metadata API, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-21-realtime-permission-decoupling-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `migrations/014_meta_tables_realtime_enabled.up.sql` | Create | Add `realtime_enabled` column to all per-schema `_meta_tables` |
| `migrations/014_meta_tables_realtime_enabled.down.sql` | Create | Remove `realtime_enabled` column from all per-schema `_meta_tables` |
| `apps/api/src/cli/migrate.ts` | Modify | Add bootstrap detection for migration 014 |
| `apps/api/src/modules/schema/schema.service.ts` | Modify | Add `realtime_enabled` to `_meta_tables` DDL in both `createTenantSchema` and `createProjectSchema` |
| `apps/api/src/modules/table/table.service.ts` | Modify | Skip `select_permission` for `anonymous` role in `trackTableInHasura`; add cleanup in `trackAllTablesInHasura` |
| `apps/api/src/modules/realtime/realtime.service.ts` | Modify | Read `realtime_enabled` from `_meta_tables` via LEFT JOIN; hardcode `anonymous` role; remove `role` param and validation |
| `apps/api/src/modules/realtime/realtime.controller.ts` | Modify | Remove `role` from `ConfigureSubscriptionBody` and controller logic |
| `apps/admin/src/lib/api.ts` | Modify | Remove `role` from `configureRealtimeSubscription` type |
| `tests/integration/realtime.test.ts` | Modify | Remove role validation tests; update `configureTableSubscription` calls |
| `tests/integration/table.test.ts` | Modify | Add `realtime_enabled` to `_meta_tables` DDL |
| `tests/integration/svar-datagrid.test.ts` | Modify | Add `realtime_enabled` to `_meta_tables` DDL |
| `tests/e2e/svar-datagrid.test.ts` | Modify | Add `realtime_enabled` to `_meta_tables` DDL (if present) |

---

### Task 1: Database Migration — Add `realtime_enabled` Column

**Files:**
- Create: `migrations/014_meta_tables_realtime_enabled.up.sql`
- Create: `migrations/014_meta_tables_realtime_enabled.down.sql`
- Modify: `apps/api/src/cli/migrate.ts:198` (add dataCheck for 014)

- [ ] **Step 1: Write the up migration**

```sql
-- migrations/014_meta_tables_realtime_enabled.up.sql
-- Add realtime_enabled column to all per-schema _meta_tables
-- _meta_tables exists in each tenant/project schema, so we must iterate

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT schema_name FROM druvia_schema_registry
  LOOP
    EXECUTE format(
      'ALTER TABLE %I._meta_tables ADD COLUMN IF NOT EXISTS realtime_enabled BOOLEAN NOT NULL DEFAULT false',
      r.schema_name
    );
  END LOOP;
END $$;
```

- [ ] **Step 2: Write the down migration**

```sql
-- migrations/014_meta_tables_realtime_enabled.down.sql
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT schema_name FROM druvia_schema_registry
  LOOP
    EXECUTE format(
      'ALTER TABLE %I._meta_tables DROP COLUMN IF EXISTS realtime_enabled',
      r.schema_name
    );
  END LOOP;
END $$;
```

- [ ] **Step 3: Add bootstrap detection for migration 014**

In `apps/api/src/cli/migrate.ts`, add to the `dataChecks` object (around line 198):

```typescript
// Before:
const dataChecks: Record<number, string> = {
  10: `SELECT EXISTS (SELECT 1 FROM druvia_tenants WHERE tenant_id = 'default') as exists`,
};

// After:
const dataChecks: Record<number, string> = {
  10: `SELECT EXISTS (SELECT 1 FROM druvia_tenants WHERE tenant_id = 'default') as exists`,
  14: `SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = '_meta_tables' AND column_name = 'realtime_enabled'
    LIMIT 1
  ) as exists`,
};
```

- [ ] **Step 4: Run migration to verify**

Run: `pnpm migrate up`
Expected: Migration 014 applies successfully, all `_meta_tables` in existing schemas gain `realtime_enabled` column.

- [ ] **Step 5: Verify down migration**

Run: `pnpm migrate down` (rolls back 014)
Then: `pnpm migrate up` (re-applies)
Expected: Both directions work cleanly.

- [ ] **Step 6: Commit**

```bash
git add migrations/014_meta_tables_realtime_enabled.up.sql migrations/014_meta_tables_realtime_enabled.down.sql apps/api/src/cli/migrate.ts
git commit -m "feat(db): add realtime_enabled column to _meta_tables (migration 014)"
```

---

### Task 2: Schema DDL — Add `realtime_enabled` to New Schema Creation

**Files:**
- Modify: `apps/api/src/modules/schema/schema.service.ts:26-33` (createTenantSchema DDL)
- Modify: `apps/api/src/modules/schema/schema.service.ts:90-97` (createProjectSchema DDL)

- [ ] **Step 1: Update `createTenantSchema` DDL**

In `schema.service.ts` around line 26-33, add `realtime_enabled` column:

```sql
CREATE TABLE IF NOT EXISTS "${schemaName}"._meta_tables (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(128) NOT NULL UNIQUE,
  description TEXT,
  row_count BIGINT DEFAULT 0,
  realtime_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
)
```

- [ ] **Step 2: Update `createProjectSchema` DDL**

In `schema.service.ts` around line 90-97, same change:

```sql
CREATE TABLE IF NOT EXISTS "${schemaName}"._meta_tables (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(128) NOT NULL UNIQUE,
  description TEXT,
  row_count BIGINT DEFAULT 0,
  realtime_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
)
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/schema/schema.service.ts
git commit -m "feat(schema): add realtime_enabled to _meta_tables DDL"
```

---

### Task 3: table.service.ts — Split Anonymous Permissions

**Files:**
- Modify: `apps/api/src/modules/table/table.service.ts:136-180` (trackTableInHasura)
- Modify: `apps/api/src/modules/table/table.service.ts:576-697` (trackAllTablesInHasura)

- [ ] **Step 1: Modify `trackTableInHasura` to skip anonymous select_permission**

Replace the permissions loop (lines 152-179) with role-specific logic:

```typescript
// 2. Add permissions for 'user' role (full CRUD)
const table = { schema: schemaName, name: tableName };
const userPermissionOps = [
  { type: 'pg_create_select_permission', permission: { columns: '*', filter: {}, allow_aggregations: true } },
  { type: 'pg_create_insert_permission', permission: { columns: '*', check: {} } },
  { type: 'pg_create_update_permission', permission: { columns: '*', filter: {}, check: {} } },
  { type: 'pg_create_delete_permission', permission: { filter: {} } },
];

for (const op of userPermissionOps) {
  try {
    await hasuraMetadataRequest(op.type, {
      source: 'default',
      table,
      role: 'user',
      permission: op.permission,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (!errorMsg.includes('already exists')) {
      console.warn(`Failed to create ${op.type} for user on ${schemaName}.${tableName}:`, errorMsg);
    }
  }
}

// 3. Add permissions for 'anonymous' role (insert/update/delete only, NO select)
// anonymous select_permission is managed by Realtime page
const anonPermissionOps = [
  { type: 'pg_create_insert_permission', permission: { columns: '*', check: {} } },
  { type: 'pg_create_update_permission', permission: { columns: '*', filter: {}, check: {} } },
  { type: 'pg_create_delete_permission', permission: { filter: {} } },
];

for (const op of anonPermissionOps) {
  try {
    await hasuraMetadataRequest(op.type, {
      source: 'default',
      table,
      role: 'anonymous',
      permission: op.permission,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (!errorMsg.includes('already exists')) {
      console.warn(`Failed to create ${op.type} for anonymous on ${schemaName}.${tableName}:`, errorMsg);
    }
  }
}
```

- [ ] **Step 2: Add cleanup logic to `trackAllTablesInHasura`**

After the existing track loop (around line 596), add cleanup of stale anonymous select_permissions. Insert this block after the `// 1. Track tables + permissions` loop and before `// 2. Create relationships`:

```typescript
// 1.5 Clean up anonymous select_permission for tables where realtime is disabled
try {
  const metaRows = await query<{ table_name: string; realtime_enabled: boolean }>(
    `SELECT table_name, realtime_enabled FROM "${schemaName}"._meta_tables`,
    []
  );
  const realtimeEnabledSet = new Set(
    metaRows.filter(r => r.realtime_enabled).map(r => r.table_name)
  );

  for (const table of tables) {
    if (!realtimeEnabledSet.has(table.tableName)) {
      // Drop anonymous select_permission if it exists (legacy cleanup)
      try {
        await hasuraMetadataRequest('pg_drop_select_permission', {
          source: 'default',
          table: { schema: schemaName, name: table.tableName },
          role: 'anonymous',
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!errorMsg.includes('does not exist')) {
          console.warn(`Failed to drop anonymous select_permission on ${schemaName}.${table.tableName}:`, errorMsg);
        }
      }
    }
  }
} catch (error) {
  console.warn('Failed to clean up anonymous select_permissions:', error);
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @druvia/shared build && pnpm --filter @druvia/api build`
Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/table/table.service.ts
git commit -m "feat(table): split anonymous permissions, skip select for realtime control"
```

---

### Task 4: realtime.service.ts — Read from `_meta_tables`, Hardcode Anonymous Role

**Files:**
- Modify: `apps/api/src/modules/realtime/realtime.service.ts:86-142` (getTableSubscriptions)
- Modify: `apps/api/src/modules/realtime/realtime.service.ts:160-233` (configureTableSubscription)
- Modify: `apps/api/src/modules/realtime/realtime.service.ts:391-402` (remove ALLOWED_ROLES, validateRole)

- [ ] **Step 1: Rewrite `getTableSubscriptions` to use LEFT JOIN with `_meta_tables`**

Replace lines 86-142:

```typescript
export async function getTableSubscriptions(schemaName: string): Promise<TableSubscription[]> {
  validateSchemaName(schemaName);

  // LEFT JOIN information_schema.tables with _meta_tables to get realtime_enabled
  // Tables not in _meta_tables default to realtime_enabled=false
  const rows = await query<{ table_name: string; realtime_enabled: boolean }>(
    `SELECT t.table_name, COALESCE(m.realtime_enabled, false) as realtime_enabled
     FROM information_schema.tables t
     LEFT JOIN "${schemaName}"._meta_tables m ON m.table_name = t.table_name
     WHERE t.table_schema = $1
       AND t.table_type = 'BASE TABLE'
       AND t.table_name NOT LIKE '\\_%'
     ORDER BY t.table_name`,
    [schemaName]
  );

  return rows.map((row) => ({
    tableName: row.table_name,
    schemaName,
    enabled: row.realtime_enabled,
    operations: ['INSERT', 'UPDATE', 'DELETE'] as const,
    hasSelectPermission: row.realtime_enabled,
  }));
}
```

- [ ] **Step 2: Rewrite `configureTableSubscription` to use anonymous role and update `_meta_tables`**

Replace lines 160-233:

```typescript
const REALTIME_ROLE = 'anonymous';

export async function configureTableSubscription(
  schemaName: string,
  tableName: string,
  enabled: boolean,
): Promise<TableSubscription> {
  validateSchemaName(schemaName);
  validateTableName(tableName);

  // Upsert _meta_tables.realtime_enabled (handles tables not yet registered in _meta_tables)
  await query(
    `INSERT INTO "${schemaName}"._meta_tables (table_name, realtime_enabled, updated_at)
     VALUES ($2, $1, NOW())
     ON CONFLICT (table_name) DO UPDATE SET realtime_enabled = $1, updated_at = NOW()`,
    [enabled, tableName]
  );

  if (enabled) {
    // 1. Track table if not tracked
    try {
      await hasuraMetadataRequest('pg_track_table', {
        source: 'default',
        table: { schema: schemaName, name: tableName },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes('already tracked') && !errorMsg.includes('already exists')) {
        throw error;
      }
    }

    // 2. Add select permission for anonymous role to enable subscription
    try {
      await hasuraMetadataRequest('pg_create_select_permission', {
        source: 'default',
        table: { schema: schemaName, name: tableName },
        role: REALTIME_ROLE,
        permission: {
          columns: '*',
          filter: {},
          allow_aggregations: false,
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes('already exists') && !errorMsg.includes('already defined')) {
        throw error;
      }
    }
  } else {
    // Drop anonymous select permission to disable subscription
    try {
      await hasuraMetadataRequest('pg_drop_select_permission', {
        source: 'default',
        table: { schema: schemaName, name: tableName },
        role: REALTIME_ROLE,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes('does not exist')) {
        throw error;
      }
    }
  }

  return {
    tableName,
    schemaName,
    enabled,
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    hasSelectPermission: enabled,
  };
}
```

- [ ] **Step 3: Remove unused types and validation**

Delete lines 391-402 (the `ALLOWED_ROLES` constant, `AllowedRole` type, and `validateRole` function). Also remove the `HasuraMetadataResponse` and `HasuraTable` interfaces (lines 35-55) since `getTableSubscriptions` no longer calls `export_metadata`.

**Keep `hasuraMetadataRequest` (line 57-76)** — it's exported and used by `table.service.ts` and still used by `configureTableSubscription`.

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @druvia/shared build && pnpm --filter @druvia/api build`
Expected: No TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/realtime/realtime.service.ts
git commit -m "feat(realtime): read realtime_enabled from _meta_tables, use anonymous role"
```

---

### Task 5: realtime.controller.ts — Remove `role` Parameter

**Files:**
- Modify: `apps/api/src/modules/realtime/realtime.controller.ts:19-22` (ConfigureSubscriptionBody)
- Modify: `apps/api/src/modules/realtime/realtime.controller.ts:138` (destructure)
- Modify: `apps/api/src/modules/realtime/realtime.controller.ts:151-155` (service call)

- [ ] **Step 1: Update `ConfigureSubscriptionBody` interface**

```typescript
// Before (line 19-22):
interface ConfigureSubscriptionBody {
  enabled: boolean;
  role?: string;
}

// After:
interface ConfigureSubscriptionBody {
  enabled: boolean;
}
```

- [ ] **Step 2: Update `configureSubscription` controller**

Line 138 — remove `role` from destructure:
```typescript
// Before:
const { enabled, role } = request.body;

// After:
const { enabled } = request.body;
```

Lines 151-155 — remove `role` from service call:
```typescript
// Before:
const subscription = await realtimeService.configureTableSubscription(
  schemaName,
  tableName,
  enabled,
  role
);

// After:
const subscription = await realtimeService.configureTableSubscription(
  schemaName,
  tableName,
  enabled,
);
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @druvia/api build`
Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/realtime/realtime.controller.ts
git commit -m "refactor(realtime): remove role parameter from controller"
```

---

### Task 6: Frontend API Type Cleanup

**Files:**
- Modify: `apps/admin/src/lib/api.ts:1085` (remove `role` from type)

- [ ] **Step 1: Update `configureRealtimeSubscription` type**

```typescript
// Before (line 1085):
data: { enabled: boolean; role?: string },

// After:
data: { enabled: boolean },
```

- [ ] **Step 2: Commit**

```bash
git add apps/admin/src/lib/api.ts
git commit -m "refactor(admin): remove role from realtime subscription API type"
```

---

### Task 7: Update Tests

**Files:**
- Modify: `tests/integration/realtime.test.ts:197-219` (remove role validation tests, add new behavior tests)
- Modify: `tests/integration/table.test.ts:15-23` (_meta_tables DDL)
- Modify: `tests/integration/svar-datagrid.test.ts:24-32` (_meta_tables DDL)

- [ ] **Step 1: Update `tests/integration/table.test.ts` _meta_tables DDL**

Add `realtime_enabled` column to the CREATE TABLE statement (around line 15-23):

```sql
CREATE TABLE "${testSchema}"._meta_tables (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(128) UNIQUE NOT NULL,
  description TEXT,
  row_count BIGINT DEFAULT 0,
  realtime_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
)
```

- [ ] **Step 2: Update `tests/integration/svar-datagrid.test.ts` _meta_tables DDL**

Same change (around line 24-32):

```sql
CREATE TABLE "${testSchema}"._meta_tables (
  id SERIAL PRIMARY KEY,
  table_name VARCHAR(128) UNIQUE NOT NULL,
  description TEXT,
  row_count BIGINT DEFAULT 0,
  realtime_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
)
```

- [ ] **Step 3: Check `tests/e2e/svar-datagrid.test.ts`**

Line 82-84 inserts into `_meta_tables` but doesn't create the table (uses existing schema). No DDL change needed — the INSERT doesn't reference `realtime_enabled` and the column has a DEFAULT, so it's fine.

- [ ] **Step 4: Update `tests/integration/realtime.test.ts`**

Remove the entire `describe('Role Validation', ...)` block (lines 197-219).

Register the test table in `_meta_tables` in `beforeAll` (after the CREATE TABLE statement, around line 47):

```typescript
// Register test table in _meta_tables (required for realtime_enabled tracking)
await pool.query(`
  INSERT INTO ${testSchemaName}._meta_tables (table_name, description)
  VALUES ('test_realtime_table', 'Test table for realtime')
  ON CONFLICT (table_name) DO NOTHING
`);
```

- [ ] **Step 5: Add new tests for core realtime_enabled behavior**

Add a new `describe` block in `tests/integration/realtime.test.ts`:

```typescript
describe('realtime_enabled behavior', () => {
  it('getTableSubscriptions should return enabled=false by default', async () => {
    const subscriptions = await realtimeService.getTableSubscriptions(testSchemaName);
    const testTable = subscriptions.find(s => s.tableName === 'test_realtime_table');

    expect(testTable).toBeDefined();
    expect(testTable!.enabled).toBe(false);
  });

  it('configureTableSubscription should update _meta_tables.realtime_enabled', async () => {
    // Enable
    const result = await realtimeService.configureTableSubscription(
      testSchemaName,
      'test_realtime_table',
      true,
    );
    expect(result.enabled).toBe(true);

    // Verify in DB
    const dbResult = await pool.query(
      `SELECT realtime_enabled FROM ${testSchemaName}._meta_tables WHERE table_name = $1`,
      ['test_realtime_table']
    );
    expect(dbResult.rows[0].realtime_enabled).toBe(true);

    // Verify getTableSubscriptions reflects the change
    const subscriptions = await realtimeService.getTableSubscriptions(testSchemaName);
    const testTable = subscriptions.find(s => s.tableName === 'test_realtime_table');
    expect(testTable!.enabled).toBe(true);

    // Disable
    await realtimeService.configureTableSubscription(
      testSchemaName,
      'test_realtime_table',
      false,
    );

    const after = await pool.query(
      `SELECT realtime_enabled FROM ${testSchemaName}._meta_tables WHERE table_name = $1`,
      ['test_realtime_table']
    );
    expect(after.rows[0].realtime_enabled).toBe(false);
  });

  it('configureTableSubscription should upsert for unregistered tables', async () => {
    // Create a table not in _meta_tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${testSchemaName}.unregistered_table (
        id SERIAL PRIMARY KEY
      )
    `);

    // Should upsert into _meta_tables
    const result = await realtimeService.configureTableSubscription(
      testSchemaName,
      'unregistered_table',
      true,
    );
    expect(result.enabled).toBe(true);

    // Verify row was created in _meta_tables
    const dbResult = await pool.query(
      `SELECT realtime_enabled FROM ${testSchemaName}._meta_tables WHERE table_name = $1`,
      ['unregistered_table']
    );
    expect(dbResult.rows.length).toBe(1);
    expect(dbResult.rows[0].realtime_enabled).toBe(true);

    // Cleanup
    await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.unregistered_table`);
    await pool.query(
      `DELETE FROM ${testSchemaName}._meta_tables WHERE table_name = $1`,
      ['unregistered_table']
    );
  });
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm test -- --run`
Expected: All tests pass. The role validation tests are gone. Table/svar-datagrid tests work with the new DDL.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/realtime.test.ts tests/integration/table.test.ts tests/integration/svar-datagrid.test.ts
git commit -m "test: update _meta_tables DDL and remove role validation tests"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Full build**

Run: `pnpm --filter @druvia/shared build && pnpm build`
Expected: Clean build, no errors.

- [ ] **Step 2: Run all tests**

Run: `pnpm test -- --run`
Expected: All tests pass.

- [ ] **Step 3: Manual smoke test (if Docker environment available)**

1. Start dev environment: `make dev-up`
2. Run migration: `pnpm migrate up`
3. Open Tables page → click "同步 GraphQL 权限"
4. Open Realtime page → verify all tables show as "disabled"
5. Enable realtime for 3 specific tables
6. Verify only those 3 show as "enabled"
7. Test SDK subscription to an enabled table → should work
8. Test SDK subscription to a disabled table → should fail/be rejected
