# Project Data Access Batch 4 Legacy Migration And Production Gate

Date: 2026-08-18

Status: Implemented; unit/build and local PostgreSQL/Hasura integration verified; real release/OTA rehearsal deferred

## 1. Goal

Provide a guarded, project-level migration path for existing Druvia projects that still run in `compatibility` mode. The migration must inventory legacy `user` / `anonymous` permissions, create or preserve project-scoped permissions, verify HTTP and Realtime isolation, remove legacy permissions, activate `explicit` mode, and support exact recovery without exposing Hasura internals as the normal product workflow.

Actual GitHub release publishing, Registry rehearsal, production OTA, and disaster-recovery drills are explicitly outside this slice. Batch 4 adds code, database migration, automated tests, build gates, and release compatibility documentation only.

## 2. Confirmed Product Decisions

The following decisions are fixed for this slice:

1. Only exact Druvia-generated historical permissions are eligible for automatic migration.
2. Any custom, duplicate, or unrecognized legacy permission blocks activation until it is manually mapped or removed.
3. Migration records keep an immutable project-scoped permission snapshot and plan in PostgreSQL. They do not restore the complete Hasura metadata export.
4. Existing recognized scoped permissions take precedence over inferred legacy targets.
5. Historical authenticated full CRUD can be inferred as project-scoped authenticated `all` access, but metadata cannot distinguish “never configured” from “explicitly closed”. Every inferred target is therefore shown for review and can be skipped per table to preserve a closed target.
6. Historical anonymous select follows the same reviewed inference path to project-scoped anonymous read access.
7. Historical anonymous insert/update/delete never maps to new anonymous write access. It is reported as a destructive removal and requires explicit confirmation.
8. Historical authenticated select enabled aggregations, while the current managed scoped policy disables them. That capability reduction is reported as a destructive change and uses the same explicit confirmation boundary.
9. Apply, recovery, rollback, and adjacent managed writes use an ordered global-shared/project-exclusive PostgreSQL advisory-lock protocol; global-scope and destructive managed paths use the global lock exclusively.
10. Apply failures restore the pre-migration permission snapshot and `compatibility` mode. Rollback failures restore the persisted applied snapshot and `explicit` mode.
11. Manual rollback is allowed only for the latest applied migration while metadata still matches its post-apply digest.
12. Production verification is read-only. It must not insert, update, or delete rows in application tables.
13. The Admin experience uses “data access upgrade”, “old rules”, “verification”, and “rollback”; raw role names and metadata remain server-side.

## 3. Non-Goals

- Building a raw Hasura permission editor.
- Automatically translating arbitrary custom filters, presets, or role hierarchies.
- Supporting application identities for non-default project environments.
- Cutting over Storage, RPC, or Functions actors.
- Building a generic queue, scheduler, or worker runtime.
- Writing probe rows into production business tables.
- Removing `HASURA_GRAPHQL_UNAUTHORIZED_ROLE` while any project remains in compatibility mode.
- Running `workflow_dispatch`, publishing images, exercising Registry mirrors, or performing production OTA during this slice.

## 4. Architecture

Batch 4 uses a synchronous, persisted project migration state machine. A preview request exports the current default-source metadata, narrows it to the project schema, classifies known legacy and scoped permissions, and persists an immutable snapshot plus migration plan. An apply request obtains the ordered advisory locks, re-exports metadata, checks the snapshot digest, executes each guarded stage, and persists stage transitions so an interrupted operation can be restored.

The implementation remains inside the existing `data-access` API module:

- `data-access-migration-inspection.ts` normalizes and classifies project permissions.
- `data-access-migration-plan.ts` creates canonical snapshots, plans, summaries, and SHA-256 digests.
- `data-access-migration.repository.ts` owns migration records and guarded status changes.
- `data-access-mutation-lock.ts` owns the single ordered global/project advisory-lock contract used by migration and adjacent management writes.
- `data-access-migration-verifier.ts` performs metadata, HTTP, WebSocket, and cross-project read-only checks.
- `data-access-migration.service.ts` orchestrates preview, apply, recovery, rollback preview, and rollback.
- Existing `data-access.controller.ts` and `data-access.routes.ts` expose management endpoints.
- Admin adds one focused migration component to the existing project Data Access page.

No generic background worker is introduced. The apply request remains synchronous, while every stage is persisted. Admin polls the status endpoint during the request so progress remains visible. If the API process exits, the explicit recovery request may proceed only after it acquires the ordered advisory locks; interrupted operations always recover backward instead of resuming forward from an unknown point.

The advisory lock is cooperative across Druvia management writes and follows one fixed order on one dedicated PostgreSQL client. Preview, migration, and ordinary project-scoped Data Access/Realtime/DDL paths first acquire a deployment-wide shared mutation lock, then the project's exclusive lock. Global-scope or destructive paths acquire the global lock exclusively before the route project's lock: raw SQL import can execute schema-qualified statements; schema sync/track-all can use full `replace_metadata`; table/project/environment deletion uses cascade behavior; and backup restore uses `pg_restore --clean`. This avoids pretending those operations are project-contained and prevents export/replace or dependency cleanup from changing another project's migration context concurrently. After acquiring the project lock, every ordinary managed mutation checks persisted migration state and refuses `applying`, `rolling_back`, or either recovery-required failure; exclusive-global paths additionally refuse while any project has one of those persisted states because their effects are not provably project-contained. These checks protect crashed operations whose session locks have already disappeared. Migration orchestration uses an explicit operation/migration-ID context and performs its own guarded state validation. Different projects' ordinary managed changes still share the global lock and remain concurrent. Lock-aware entry points call non-locking internal primitives so nested service calls never reacquire either lock on another pool client.

Project deletion acquires exclusive-global/project locks and checks for active or recovery-required migration rows before dropping the database user, schemas, metadata, storage, or backups; the database trigger remains a final race/backstop, never the first guard after destructive cleanup. Tenant deletion is the exception: its current service performs only one database delete, and acquiring an unknown number of project locks would introduce multi-lock ordering and partial-cleanup risk, so the database delete guard atomically rejects the entire tenant cascade whenever any child project has an active or recovery-required migration. Direct database SQL or direct Hasura Console changes cannot be locked by Druvia; the Admin dialog therefore requires a quiet migration window, and digest/verification checks fail the operation if external drift is observed.

## 5. Database Model

Migration `019_data_access_migrations` creates `druvia_data_access_migrations`:

```sql
CREATE TABLE druvia_data_access_migrations (
  id BIGSERIAL PRIMARY KEY,
  migration_id VARCHAR(64) NOT NULL UNIQUE,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL,
  phase VARCHAR(32) NOT NULL,
  source_snapshot JSONB NOT NULL,
  migration_plan JSONB NOT NULL,
  source_digest CHAR(64) NOT NULL,
  applied_snapshot JSONB,
  applied_digest CHAR(64),
  rollback_preview_digest CHAR(64),
  recovery_target VARCHAR(16),
  has_destructive_changes BOOLEAN NOT NULL DEFAULT FALSE,
  created_by VARCHAR(64) NOT NULL,
  error_code VARCHAR(64),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT druvia_data_access_migrations_status_check CHECK (
    status IN (
      'preview_ready',
      'applying',
      'applied',
      'rolling_back',
      'rolled_back',
      'recovered',
      'failed',
      'superseded'
    )
  ),
  CONSTRAINT druvia_data_access_migrations_phase_check CHECK (
    phase IN (
      'preview',
      'snapshot_check',
      'prepare_scoped_permissions',
      'verify_scoped_metadata',
      'verify_scoped_http',
      'verify_scoped_realtime',
      'remove_legacy_permissions',
      'activate_explicit_mode',
      'verify_active_runtime',
      'rollback_snapshot_check',
      'restore_permissions',
      'restore_runtime_mode',
      'verify_recovery_target',
      'completed'
    )
  ),
  CONSTRAINT druvia_data_access_migrations_recovery_target_check CHECK (
    recovery_target IS NULL OR recovery_target IN ('source', 'applied')
  )
);

CREATE UNIQUE INDEX idx_data_access_migrations_active_operation
  ON druvia_data_access_migrations(project_id)
  WHERE status IN ('preview_ready', 'applying', 'rolling_back')
     OR (
       status = 'failed'
       AND error_code IN (
         'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED',
         'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'
       )
     );

CREATE UNIQUE INDEX idx_data_access_migrations_rollback_candidate
  ON druvia_data_access_migrations(project_id)
  WHERE status = 'applied';

CREATE INDEX idx_data_access_migrations_project_created
  ON druvia_data_access_migrations(project_id, created_at DESC);
```

The migration also installs an update trigger that rejects changes to `project_id`, `source_snapshot`, `migration_plan`, `source_digest`, `has_destructive_changes`, `created_by`, and `created_at`, and always sets `updated_at=NOW()`. `applied_snapshot`, `applied_digest`, and `applied_at` may transition from null exactly once, only in the guarded `applying -> applied` transition, and are immutable afterward. `completed_at` records the latest terminal operation without overwriting the original activation time exposed as `appliedAt`. The same trigger enforces the status-transition table in Section 9, requires `recovery_target='source'` while apply recovery is pending and `recovery_target='applied'` while rollback recovery is pending, and requires the target to be cleared after a terminal restoration or successful operation. Phase, `rollback_preview_digest`, other operation timestamps, and sanitized errors remain mutable only within a valid status/recovery pair. A delete trigger raises SQLSTATE `55006` with constraint name `druvia_data_access_migrations_inflight_delete_guard` for direct or cascading deletion of `applying`, `rolling_back`, or recovery-required `failed` rows. Project deletion preflights the same condition before external cleanup; project and tenant controllers map either the typed preflight error or the exact database guard error to sanitized `409 DATA_ACCESS_MIGRATION_IN_PROGRESS`, while unrelated failures are rethrown.

The down migration must refuse to drop the table while any row is `applying`, `rolling_back`, or `applied`, or while a failed row has either recovery-required error code. This prevents removal of an active recovery or rollback source. Otherwise it drops the trigger, trigger function, indexes, and table. The release rollback guide must state that migration `019` is additive and must not be rolled down automatically by OTA.

## 6. Snapshot And Plan Contract

Snapshots are internal and may contain physical role names and permission filters. They never leave the API service response.

```ts
export type DataAccessMigrationOperation = 'select' | 'insert' | 'update' | 'delete'

export interface MigrationPermissionSnapshot {
  operation: DataAccessMigrationOperation
  role: string
  permission: Record<string, unknown>
}

export interface MigrationTableSnapshot {
  tableName: string
  columns: string[]
  realtimeEnabled: boolean
  graphqlNaming: {
    customName: string | null
    customRootFields: Record<string, string>
  }
  inventoryStatus: 'managed_table' | 'tracked_only'
  permissions: MigrationPermissionSnapshot[]
}

export interface ProjectDataAccessMigrationSnapshot {
  projectId: string
  schemaName: string
  runtimeMode: 'compatibility' | 'explicit'
  sourceGraphqlNaming: Record<string, unknown> | null
  tables: MigrationTableSnapshot[]
  unsupportedApiBindings: Array<{
    kind: 'function' | 'native_query' | 'logical_model' | 'stored_procedure'
    objectName: string
    role: string
  }>
  externalScopedRoleBindings: Array<{
    schemaName: string
    tableName: string
    role: string
    operation: DataAccessMigrationOperation
  }>
}

export interface DataAccessMigrationBlocker {
  tableName: string | null
  actor: 'authenticated' | 'anonymous' | 'system'
  operation: DataAccessMigrationOperation | null
  reason:
    | 'custom_legacy_rule'
    | 'custom_scoped_rule'
    | 'duplicate_rule'
    | 'unsupported_tracked_object'
    | 'unsupported_source_customization'
    | 'cross_project_role_binding'
}

export interface DataAccessMigrationDestructiveChange {
  tableName: string
  actor: 'authenticated' | 'anonymous'
  operation: DataAccessMigrationOperation
  reason: 'anonymous_write_removed' | 'authenticated_aggregations_removed'
}

export interface ProjectDataAccessMigrationPlan {
  version: 1
  projectId: string
  schemaName: string
  targetPolicies: Array<{
    tableName: string
    source: 'existing_scoped' | 'legacy_default' | 'mixed' | 'closed'
    inferredOperations: Array<{
      actor: 'authenticated' | 'anonymous'
      operation: DataAccessMigrationOperation
    }>
    policy: TableDataAccessInput
  }>
  legacyDrops: Array<{
    tableName: string
    role: 'user' | 'anonymous'
    operation: DataAccessMigrationOperation
  }>
  blockers: DataAccessMigrationBlocker[]
  destructiveChanges: DataAccessMigrationDestructiveChange[]
}
```

Canonicalization first applies domain normalization: table-column inventories and permission `columns` arrays are deduplicated and sorted because their order is not part of the access contract, empty/default fields use the same normalized representation as the classifier, and table/permission entries are sorted by stable tuple keys. Hasura `columns: '*'` is preserved rather than rewritten to the current column array so source restoration retains its future-column semantics; changing between wildcard and an explicit array therefore changes the snapshot digest. Canonicalization then recursively sorts object keys before `JSON.stringify`. Unknown arrays retain their original order unless their contract is explicitly set-like. Digests use lowercase hexadecimal SHA-256. This prevents metadata-only array reordering from producing false drift while preserving meaningful access and ordering in unsupported/custom values.

The source digest covers `projectId`, `schemaName`, `runtimeMode`, the normalized default-source GraphQL naming customization, every tracked project-schema table/view, all project-schema permission entries, table columns, table GraphQL naming configuration, Realtime flags, every relevant actor binding on unsupported source API objects, top-level Action/Remote Schema/inherited-role bindings, and every occurrence of this project's generated scoped roles outside its default schema. It does not include connection configuration, secrets, unrelated roles, or unrelated source configuration from other schemas. Any external scoped-role occurrence adds a `cross_project_role_binding` blocker and must be removed by a deployment operator before a new preview. A tracked view or table-like object that is absent from the default business-table inventory is retained as `tracked_only`; any legacy or current-project scoped permission on it adds an `unsupported_tracked_object` blocker so migration cannot silently ignore it. A function, native query, logical model, stored procedure, Action, Remote Schema, or inherited-role binding for `user`, `anonymous`, or a current-project scoped role is recorded in `unsupportedApiBindings` and adds the same blocker because migrating those API objects is outside this slice. Inherited-role inspection covers both a relevant `role_name` and relevant base roles listed in `role_set`. Non-empty default-source naming customization is not silently ignored: Batch 4 reports an `unsupported_source_customization` project blocker because source-wide namespace/prefix/suffix rules are outside the initial verifier contract. Capturing its normalized naming-only value also makes a post-preview customization change fail the digest check without persisting source connection details.

## 7. Legacy Classification

The classifier recognizes only shapes previously generated by Druvia. It accepts Hasura-normalized omissions only where Hasura itself removes an empty/default field.

Authenticated historical defaults:

```ts
select: {
  columns: '*',
  filter: {},
  allow_aggregations: true,
}
insert: { columns: '*', check: {} }
update: { columns: '*', filter: {}, check: {} }
delete: { filter: {} }
```

Anonymous historical defaults:

```ts
select: {
  columns: '*',
  filter: {},
  allow_aggregations: false,
}
insert: { columns: '*', check: {} }
update: { columns: '*', filter: {}, check: {} }
delete: { filter: {} }
```

For historical permissions, `columns: '*'` and an array containing every current table column are accepted as Hasura-normalized equivalents. Empty or missing `set`, empty/null/missing update `check`, and missing/false `backend_only` are accepted only for the exact historical full-access shape. For historical select, missing `allow_aggregations` is accepted only as the normalized equivalent of `false`; authenticated select with `true` is recognized but produces `authenticated_aggregations_removed` because the current managed target disables aggregation. Any row filter, true column subset, non-empty preset, `backend_only: true`, aggregation change outside these known shapes, additional field, multiple entry for the same role/operation, or unknown role shape is custom.

Target policy precedence is:

1. A fully recognized current scoped policy remains unchanged.
2. If no scoped permission exists for an operation, exact authenticated legacy permission is proposed as inferred `all` unless that table appears in `skipLegacyInferenceTables`.
3. If no scoped anonymous select exists, exact legacy anonymous select is proposed as inferred `anonymous.select=true` unless inference is skipped for that table.
4. Missing recognized permissions remain closed.
5. Exact anonymous writes are listed only in `destructiveChanges` and `legacyDrops`.
6. Exact historical authenticated select with aggregations maps to managed scoped `all` select and adds `authenticated_aggregations_removed` to `destructiveChanges`.
7. Any custom legacy or custom scoped entry adds a blocker and prevents apply.

## 8. Public API Contract

All endpoints require a `platform_user` and `checkProjectAccess(user.userId, projectId)`. Current product ownership means this is the tenant owner. `super_admin` does not bypass project ownership implicitly.

```text
GET  /api/v1/projects/:projectId/data-access/migration
POST /api/v1/projects/:projectId/data-access/migration/preview
POST /api/v1/projects/:projectId/data-access/migration/:migrationId/apply
POST /api/v1/projects/:projectId/data-access/migration/:migrationId/recover
POST /api/v1/projects/:projectId/data-access/migration/:migrationId/rollback-preview
POST /api/v1/projects/:projectId/data-access/migration/:migrationId/rollback
```

When no migration exists, `GET .../migration` returns `{ success: true, data: null }`. Preview is available only while the project is `compatibility`; explicit projects without a Batch 4 record remain valid new projects and return `409 PROJECT_ALREADY_EXPLICIT` from preview rather than receiving a synthetic migration record.

Preview body:

```ts
interface PreviewDataAccessMigrationInput {
  skipLegacyInferenceTables?: string[]
}
```

The first preview defaults this list to empty and reports every inferred operation. Admin may let the operator mark inferred tables as “迁移后保持关闭”, then creates a new preview with those table names; the new immutable preview supersedes the prior one. The service rejects unknown, duplicate, blocked, tracked-only, or cross-project table names. Skipping inference preserves any already-recognized scoped operations on that table and leaves only the otherwise inferred operations closed.

Apply body:

```ts
interface ApplyDataAccessMigrationInput {
  sourceDigest: string
  confirmInferredPolicies: boolean
  confirmDestructiveChanges: boolean
  projectAlias?: string
}
```

`confirmInferredPolicies` is required when the immutable plan contains inferred operations. `projectAlias` is required and must exactly match the current alias when inferred operations or destructive changes exist. A boolean without the alias is insufficient.

Recovery body:

```ts
interface RecoverDataAccessMigrationInput {
  expectedRecoveryDigest: string
  projectAlias: string
}
```

Recovery is accepted only for interrupted `applying` / `rolling_back` records or a `failed` record carrying one of the two recovery-required error codes. An ordinary `failed` apply whose automatic restoration already matched `source_digest` needs a new preview, not recovery. If the advisory lock cannot be acquired, the original operation is still active and recovery returns `409`. `expectedRecoveryDigest` must equal the digest selected by the persisted `recovery_target`: apply interruption restores the immutable source snapshot and `compatibility` mode, while rollback interruption restores the immutable applied snapshot and `explicit` mode. Recovery never resumes the interrupted operation forward.

Rollback body:

```ts
interface RollbackDataAccessMigrationInput {
  rollbackPreviewDigest: string
  projectAlias: string
}
```

`requiredRecoveryDigest` and the business-facing `recoveryTarget` are non-null only while explicit recovery is eligible. The API never exposes `recovery_target`, `applied_snapshot`, physical role names, or metadata JSON directly.

Public responses expose only business summaries:

```ts
export interface ProjectDataAccessMigrationReport {
  migrationId: string
  projectId: string
  status: DataAccessMigrationStatus
  phase: DataAccessMigrationPhase
  sourceDigest: string
  requiredRecoveryDigest: string | null
  recoveryTarget: 'pre_migration' | 'current_explicit' | null
  appliedAt: string | null
  canApply: boolean
  canRollback: boolean
  summary: {
    totalTables: number
    migratedTables: number
    preservedScopedTables: number
    inferredOperationCount: number
    blockerCount: number
    destructiveChangeCount: number
  }
  blockers: DataAccessMigrationBlocker[]
  destructiveChanges: DataAccessMigrationDestructiveChange[]
  tables: Array<{
    tableName: string
    targetSource: 'existing_scoped' | 'legacy_default' | 'mixed' | 'closed'
    inferredOperations: Array<{
      actor: 'authenticated' | 'anonymous'
      operation: DataAccessMigrationOperation
    }>
    authenticated: 'closed' | 'read_only' | 'write_only' | 'read_write'
    anonymousRead: boolean
    removesAnonymousWrite: boolean
    removesAuthenticatedAggregations: boolean
    blocked: boolean
  }>
  error: { code: string; message: string } | null
}
```

Summary counts are deterministic but not a partition: `totalTables` counts managed business tables, `migratedTables` counts tables with at least one inferred target operation, and `preservedScopedTables` counts tables with at least one recognized existing scoped operation. A `mixed` table may appear in both latter counts. Blocked tracked-only objects are represented in `blockerCount`, not `totalTables`.

Raw upstream errors are logged with request/migration/project IDs but are never returned. Expected status mapping:

- `400`: malformed confirmation or digest.
- `401`: no platform authentication.
- `403`: no project ownership.
- `404`: project or migration not found.
- `409`: blocked plan, stale digest, drift, invalid state, lock conflict, or unavailable rollback.
- `502`: Hasura verification or metadata service unavailable after automatic restoration is attempted.
- `500`: internal persistence failure with a generic message.

## 9. Apply State Machine

Allowed terminal and recovery transitions are explicit:

| From | Event | To |
| --- | --- | --- |
| `preview_ready` | superseded by a new preview | `superseded` |
| `preview_ready` | apply begins | `applying` |
| `applying` | apply succeeds | `applied` |
| `applying` | apply fails and source restoration succeeds | `failed` |
| `applying` | interrupted apply recovery succeeds | `recovered` |
| `failed` + `DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED` | source recovery begins | `applying` |
| `applied` | rollback begins | `rolling_back` |
| `rolling_back` | rollback succeeds | `rolled_back` |
| `rolling_back` | rollback fails and applied restoration succeeds | `applied` |
| `rolling_back` | interrupted rollback recovery succeeds | `applied` |
| `failed` + `DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED` | applied recovery begins | `rolling_back` |

Any restoration that does not reach its expected digest becomes `failed` with the matching recovery-required error. No other transition is accepted by the database trigger or repository.

Apply stages are persisted in this order:

```text
snapshot_check
prepare_scoped_permissions
verify_scoped_metadata
verify_scoped_http
verify_scoped_realtime
remove_legacy_permissions
activate_explicit_mode
verify_active_runtime
completed
```

Execution rules:

1. On one dedicated client, acquire `pg_try_advisory_lock_shared(hashtextextended('data-access-mutation:global', 0))`, then `pg_try_advisory_lock(hashtextextended('data-access-migration:' || projectId, 0))`. Preview creation uses the same ordered lock pair so snapshotting, superseding, and insertion cannot race managed writes or raw SQL import.
2. Load the migration/project, require `preview_ready` and `compatibility`, and validate the plan plus all confirmations.
3. Export a fresh project snapshot and require its digest to equal `source_digest`. Drift returns `409` without changing the preview status.
4. Use one guarded `UPDATE ... WHERE migration_id=$1 AND status='preview_ready'` to mark `applying`, set `snapshot_check` and `recovery_target='source'`, and require one returned row. The ordered advisory locks already serialize Druvia-managed operations, so no database transaction is held during Hasura or WebSocket calls.
5. Persist each later phase with a guarded `WHERE migration_id=$1 AND status='applying'` update before its external side effect.
6. Submit only the planned scoped permission commands as one metadata batch and preserve every unrelated role and table configuration. Try `bulk_atomic` first; Hasura v2.48 rejects permission commands there, so only that exact unsupported-command response may fall back to `bulk`. The persisted phase, re-exported metadata verification, and snapshot restoration remain the safety boundary because the fallback is not transactional.
7. Re-export metadata and verify the scoped permission structures and global role isolation.
8. Verify HTTP schema visibility with server-derived role/session headers and verify WebSocket acknowledgment with short-lived Realtime JWTs against the internal Hasura endpoint, without writing rows. Public ingress reachability remains covered by the existing Admin Realtime connection test and is not coupled to permission migration.
9. Submit one guarded metadata batch to drop only the exact snapshot legacy permissions, using the same narrowly scoped `bulk_atomic`-to-`bulk` compatibility behavior.
10. Update `druvia_projects.data_access_mode='explicit'` with `WHERE data_access_mode='compatibility'`; require exactly one row.
11. Re-export and verify the active runtime path, then persist the resulting canonical `applied_snapshot`, `applied_digest`, and `applied_at`, clear `recovery_target`, and mark `applied` in one guarded transition.
12. Release the project lock and then the global shared lock in reverse order in `finally`, followed by the dedicated client.

Preview creation runs under the same ordered advisory locks, supersedes the old `preview_ready` row, and then inserts the new immutable row. A failure between those two statements is recoverable by generating a fresh preview and does not begin external side effects. Apply, rollback, and recovery transitions are single guarded updates that require the expected prior status; they never keep a PostgreSQL transaction open while calling Hasura. Recovery clears the prior recovery error and sets phase `restore_permissions` before external calls; a recovery-required `failed` row first transitions back to `applying` for `source` or `rolling_back` for `applied` and preserves the recovery target so Admin resumes normal polling.

If any side effect after `applying` fails, restoration executes while the lock is still held:

1. Re-export current metadata, diff only the touched `user`, `anonymous`, and current-project scoped permissions against `source_snapshot`, then restore that difference in one guarded metadata batch. Do not issue unconditional drops for permissions that are already absent.
2. Set the project mode to `compatibility`.
3. Re-export and require the restored digest to equal `source_digest`, then perform read-only HTTP actor resolution/introspection and Realtime acknowledgment for the restored compatibility target.
4. Clear `recovery_target`, then mark `failed` with the failed phase and a sanitized error code/message.

Automatic and explicit restoration persist `restore_permissions`, `restore_runtime_mode`, and `verify_recovery_target` immediately before their corresponding side effects/check, using guarded updates for the current active status.

If restoration itself fails, the record remains `failed` with `DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED` and `recovery_target='source'`. A later recovery request may acquire the lock and repeat restoration from the immutable source snapshot. Successful explicit recovery marks the migration `recovered`, clears the recovery target/error, and leaves the project in `compatibility`. No interrupted operation resumes forward.

## 10. Verification

`data-access-migration-verifier.ts` performs the first three checks below; the fourth defines real integration coverage for the combined workflow.

### 10.1 Metadata Structure

- Every planned scoped permission exists exactly once with the planned normalized shape.
- No scoped role for this project exists on a table outside the project schema.
- Every planned legacy drop matches the source snapshot before removal.
- After removal, no `user` / `anonymous` permission remains in the project schema.

### 10.2 HTTP Schema Visibility

For authenticated and anonymous scoped actors, send the same server-derived `x-hasura-role` and session-variable headers used by the GraphQL proxy, together with the server-only Hasura admin secret, to `${config.hasura.endpoint}/v1/graphql`. The verifier never returns or logs those headers. Send this read-only query:

```graphql
query DruviaMigrationSchemaProbe {
  __schema {
    queryType { fields { name } }
    mutationType { fields { name } }
    subscriptionType { fields { name } }
  }
}
```

Compare visible root fields with the current normalized permission snapshot for the active Hasura role; the migration plan determines the managed table scope. This matters during compatibility rollback because legacy authenticated select may legitimately expose aggregate roots while the explicit target does not. Standard Hasura roots are derived from the tracked table name and schema; table-level `configuration.custom_name` and `configuration.custom_root_fields` are honored when present. Non-empty source-wide naming customization blocks preview as described above. The verifier requires expected operations to be visible, closed operations and disabled aggregate roots to be absent, and roots belonging to other project schemas to be absent.

The pre-cutover scoped check may build role/session headers directly from trusted internal scoped execution contexts because the project is still in `compatibility`. The final `verify_active_runtime` stage must reload the project and pass synthetic same-project authenticated and anonymous contexts through the same `resolveProjectDataExecutionContext` path used by the GraphQL proxy, assert that it selected the expected scoped actor/session variables, and only then run the internal Hasura introspection. It must not sign an HTTP JWT, duplicate role-selection logic, expose the admin secret, or call public ingress.

### 10.3 Realtime Handshake

Add `graphql-ws` and `ws` to `@druvia/api`. Convert `config.hasura.endpoint` to its internal WebSocket URL, open one disposable connection per actor using the internal short-lived token, require `connection_ack` within five seconds, then dispose. Pre-cutover may issue from a trusted scoped `RealtimeExecutionContext`; final active verification must pass both synthetic actors through `resolveRealtimeExecutionContext` and `issueRealtimeAccessToken`, then connect the returned token to the internal URL. This validates the production role/token path while deliberately leaving public ingress reachability to the existing Admin Realtime connection test. Subscription visibility is checked through `subscriptionType` introspection; no live subscription or row mutation is required.

### 10.4 Integration Coverage

Real Hasura integration tests create two temporary project schemas and fixture tables. They verify authenticated and anonymous visibility, owner-rule metadata preservation, absence of cross-project roots, successful WebSocket acknowledgment, legacy removal, explicit activation, automatic failure restoration, and manual rollback. Fixture data belongs only to test schemas and is removed in `afterAll`.

## 11. Rollback State Machine

`rollback-preview` is available only for the latest `applied` migration. It obtains the ordered shared-global/project locks, exports the current project snapshot, requires its digest to equal `applied_digest`, and stores a digest over `{ migrationId, appliedDigest, sourceDigest, projectAlias }` in `rollback_preview_digest`.

`rollback` requires that digest and the exact current project alias. It repeats the current digest check, then:

1. Uses one expected-status guarded update to mark `rolling_back`, clear `rollback_preview_digest`, and set `recovery_target='applied'` before external side effects.
2. Re-exports current metadata and restores only the touched permission subset from `source_snapshot` with one diff-based guarded metadata batch.
3. Updates the project mode to `compatibility`.
4. Re-exports and requires `source_digest`, then performs read-only HTTP actor resolution/introspection and Realtime acknowledgment for the restored compatibility target.
5. Clears `recovery_target` and marks `rolled_back`.

If rollback fails after `rolling_back`, automatic recovery diffs the current project metadata against `applied_snapshot`, restores that snapshot with one guarded metadata batch, resets the project to `explicit`, requires `applied_digest`, and repeats the read-only explicit actor HTTP/Realtime checks. Successful automatic recovery clears `recovery_target`, returns the row to `applied` with a sanitized rollback-failed error, and requires a new rollback preview before another attempt. If that recovery fails, the row becomes `failed` with `DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED` and remains protected by the active-row index and delete trigger. Explicit recovery then uses `recovery_target='applied'`; success clears the recovery target/error, returns the row to `applied`, and does not reuse the previous rollback preview.

Any relevant permission, table naming, tracked-object, column, or Realtime verification-context change after activation changes the current digest and invalidates one-click rollback. This is intentionally stricter than checking scoped permissions alone because the source permission snapshot may reference the earlier schema shape. The response instructs the administrator to create a current metadata backup and use the documented manual recovery path. Rollback explicitly warns that it may restore global legacy roles, historical anonymous writes, and authenticated aggregation access.

## 12. Admin Experience

The existing project Data Access page owns the workflow.

### Compatibility State

A full-width upgrade panel replaces the passive compatibility warning. It shows old-rule counts, review counts, latest migration state, and a primary `生成迁移预检` command.

### Preview Dialog

The dialog contains:

- summary counts;
- table-level target source and actor access summary;
- explicit review of every legacy-inferred operation, with a per-table `迁移后保持关闭` option that regenerates and supersedes the preview;
- blockers with table configuration links where a supported scoped replacement can be configured;
- an in-app `查看运维处理说明` dialog for custom legacy metadata that cannot be represented by the simplified editor; it gives business-facing handoff steps and does not depend on a deployment-specific external documentation URL;
- destructive anonymous-write and authenticated-aggregation removals;
- planned metadata, HTTP, Realtime, and isolation checks.

Apply remains disabled while blockers exist. Inferred policies require a review confirmation; destructive changes require a separate confirmation. Either condition requires exact project alias input.

### Applying State

The dialog polls `GET .../migration` every second while apply is pending. A fixed progress track maps persisted phases to:

```text
校验快照 -> 准备权限 -> 验证访问 -> 移除旧规则 -> 激活 -> 最终验证
```

The dialog cannot be dismissed through the primary close action during apply, but a browser refresh is safe. A timeout or network failure of the long apply/rollback request triggers an immediate status fetch instead of being treated as proof of operation failure. Returning to the page reloads the current state. An interrupted or recovery-required state offers either `恢复迁移前状态` or `恢复升级后状态` according to the server-provided recovery target, requiring the matching recovery digest and exact project alias before it calls the recovery endpoint.

### Explicit State And Rollback

An explicit project shows activation time and a secondary `回滚预检` command only when rollback remains eligible. If a rollback attempt failed but automatic applied-state restoration succeeded, the panel shows the sanitized failure and requires a fresh rollback preview before retry. Rollback uses a separate confirmation dialog with the project alias, rollback digest, and a prominent warning that legacy isolation and anonymous writes may return.

The UI must remain business-facing, responsive, keyboard accessible, and free of raw role names, secrets, or metadata JSON.

## 13. File Map

Create:

- `migrations/019_data_access_migrations.up.sql`
- `migrations/019_data_access_migrations.down.sql`
- `apps/api/src/modules/data-access/data-access-migration.types.ts`
- `apps/api/src/modules/data-access/data-access-migration-inspection.ts`
- `apps/api/src/modules/data-access/data-access-migration-plan.ts`
- `apps/api/src/modules/data-access/data-access-migration.repository.ts`
- `apps/api/src/modules/data-access/data-access-mutation-lock.ts`
- `apps/api/src/modules/data-access/data-access-migration-verifier.ts`
- `apps/api/src/modules/data-access/data-access-migration.service.ts`
- `apps/admin/src/lib/project-data-access-migration.ts`
- `apps/admin/src/components/data-access/ProjectDataAccessMigration.tsx`
- `tests/unit/data-access-migration-schema.test.ts`
- `tests/unit/data-access-migration-inspection.test.ts`
- `tests/unit/data-access-migration-plan.test.ts`
- `tests/unit/data-access-migration-repository.test.ts`
- `tests/unit/data-access-mutation-lock.test.ts`
- `tests/unit/data-access-migration-verifier.test.ts`
- `tests/unit/data-access-migration-service.test.ts`
- `tests/unit/data-access-migration-controller.test.ts`
- `tests/unit/sql-controller.test.ts`
- `tests/unit/backup-controller.test.ts`
- `tests/unit/backup-service.test.ts`
- `tests/unit/tenant-controller.test.ts`
- `tests/unit/environment-routes.test.ts`
- `tests/unit/environment-service.test.ts`
- `tests/unit/admin/project-data-access-migration.test.ts`
- `tests/unit/admin/project-data-access-migration-panel.test.tsx`
- `tests/integration/data-access-migration.test.ts`
- `docs/004-project-data-access-migration-guide.md`

Modify:

- `apps/api/package.json`
- `pnpm-lock.yaml`
- `apps/api/src/cli/migrate.ts`
- `apps/api/src/modules/data-access/data-access.controller.ts`
- `apps/api/src/modules/data-access/data-access.routes.ts`
- `apps/api/src/modules/data-access/data-access.service.ts`
- `apps/api/src/modules/project/project.service.ts`
- `apps/api/src/modules/project/project.controller.ts`
- `apps/api/src/modules/realtime/realtime.controller.ts`
- `apps/api/src/modules/realtime/realtime-token.service.ts`
- `apps/api/src/modules/table/table.controller.ts`
- `apps/api/src/modules/sql/sql.controller.ts`
- `apps/api/src/modules/sql/sql.service.ts`
- `apps/api/src/modules/backup/backup.controller.ts`
- `apps/api/src/modules/backup/backup.service.ts`
- `apps/api/src/modules/tenant/tenant.controller.ts`
- `apps/api/src/modules/environment/environment.routes.ts`
- `apps/api/src/modules/environment/environment.service.ts`
- `apps/admin/src/lib/api.ts`
- `apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/data-access/page.tsx`
- `apps/admin/src/components/data-access/ProjectDataAccessOverview.tsx`
- `tests/unit/api-app.test.ts`
- `tests/unit/data-access-service.test.ts`
- `tests/unit/project-controller.test.ts`
- `tests/unit/project-service.test.ts`
- `tests/unit/realtime-controller.test.ts`
- `tests/unit/table-controller.test.ts`
- `tests/unit/table-service.test.ts`
- `tests/unit/sql-service.test.ts`
- `tests/unit/admin/project-data-access-overview-panel.test.tsx`
- `.github/workflows/release.yml`
- `AGENTS.md`
- `apps/api/AGENTS.md`
- `apps/admin/AGENTS.md`
- `docs/agent/design-decisions.md`
- `docs/migration/supabase-compat.md`
- `docs/003-version-release-guide.md`
- `docs/plans/2026-08-17-project-data-access-design.md`
- `docs/progress.md`

## 14. Implementation Plan

Execution is inline in the main checkout. Do not use worktrees, subagents, per-task commits, or separate design/implementation documents. Follow TDD for each behavior: add the focused test, run it and observe the expected failure, implement, rerun the focused test, then run the adjacent regression set.

### Task 1: Add Migration 019

- [x] Create `tests/unit/data-access-migration-schema.test.ts` first. Assert both SQL files exist; the up migration creates the constrained table, immutable source fields, allowed status/recovery-target transition guard, one-time applied snapshot/digest/time transition, active/recovery-required and rollback-candidate unique indexes, the SQLSTATE/constraint-named delete guard, project foreign key, and required timestamps; the down migration refuses active, applied, and either recovery-required record before dropping all created objects.
- [x] Add a bootstrap assertion for migration `019` in `apps/api/src/cli/migrate.ts` using `information_schema.tables` for `druvia_data_access_migrations`.
- [x] Run `pnpm vitest run tests/unit/data-access-migration-schema.test.ts` and confirm it fails because migration `019` is missing.
- [x] Add the up/down SQL and bootstrap check, then rerun the focused test.
- [x] Run `pnpm vitest run tests/unit/project-data-access-mode-migration.test.ts tests/unit/data-access-migration-schema.test.ts`.

### Task 2: Build Snapshot Classification And Planning

- [x] Create classifier tests covering every exact historical operation, wildcard/full-column normalization, empty/missing `set`, null/missing update `check`, false/missing `backend_only`, Hasura-normalized select omission, aggregation removal, true column subsets, row filters, non-empty presets, extra fields, duplicate entries, tracked-only views, relevant function/native-query/logical-model/stored-procedure bindings, source customization, cross-project scoped-role bindings, recognized scoped `all/owner/anonymous-read`, custom scoped rules, per-operation precedence, mixed target sources, skipped table inference, and destructive changes.
- [x] Run the classifier tests and confirm the missing-module failure.
- [x] Add `data-access-migration.types.ts` and `data-access-migration-inspection.ts`. Reuse `inspectTableDataAccessMetadata`, `materializeTableDataAccessPolicy`, and `resolveDataScopeRole` where their contracts match; keep historical wildcard recognition isolated from current scoped parsing.
- [x] Add plan tests for deterministic ordering, recursive canonicalization, stable SHA-256 output, order-insensitive table/permission column sets, order-sensitive unknown arrays, changed-permission/root-field/tracked-object/external-binding drift, blockers, and redacted report projection.
- [x] Run plan tests and confirm the missing planner failure.
- [x] Implement `data-access-migration-plan.ts` with `canonicalizeMigrationValue`, `digestMigrationValue`, `buildProjectMigrationSnapshot`, `buildProjectMigrationPlan`, and `toPublicMigrationReport`.
- [x] Run:

```bash
pnpm vitest run \
  tests/unit/data-access-migration-inspection.test.ts \
  tests/unit/data-access-migration-plan.test.ts \
  tests/unit/data-access-inspection.test.ts \
  tests/unit/data-access-policy.test.ts
```

### Task 3: Persist Records And Lock Project Mutations

- [x] Add repository tests for immutable preview insertion, deterministic latest-record selection by `created_at DESC, id DESC`, guarded expected-status transitions, and guarded project-mode update. Advisory-lock behavior is covered separately by the mutation-lock tests.
- [x] Run the repository test and confirm the missing-module failure.
- [x] Add mutation-lock tests for stable global/project key derivation, shared-global then project-exclusive acquisition order, exclusive-global mode, each first/second-lock conflict, project-local persisted applying/rolling-back/recovery-required rejection, deployment-wide persisted-state rejection for exclusive-global operations, ordinary failed/applied allowance, migration-context bypass validation, reverse unlock order, callback failure, and unconditional client release.
- [x] Implement `data-access-mutation-lock.ts` with stable global/project key derivation and `withProjectDataAccessMutationLock(projectId, callback, options)`. Options distinguish shared/exclusive global mode and ordinary/migration purpose; migration purpose requires a concrete operation and migration ID. The helper uses one dedicated client, non-blocking advisory locks, fixed acquisition/release order, persisted-state gating for ordinary writes, and unconditional unlock/client release in `finally`.
- [x] Implement `data-access-migration.repository.ts`. Export `createMigrationPreview`, `getLatestProjectMigration`, `getProjectMigration`, `transitionMigration`, and `setProjectDataAccessMode`; use the shared mutation-lock helper in the service rather than defining a second lock key.
- [x] Keep lock and state-transition SQL parameterized. Never interpolate project IDs into SQL.
- [x] Add a narrow `updateProjectDataAccessMode(projectId, from, to, client?)` helper to `project.service.ts` only if repository ownership would otherwise duplicate project row mapping.
- [x] Wrap ordinary Druvia management paths that can alter the default project migration snapshot in shared-global/project mode: table create, column add/drop/rename, foreign-key add/drop, track-one, table data-access update, and default-environment Realtime configuration. Use exclusive-global/project mode for raw SQL import, schema sync/track-all, table drop/untrack cascade, clean backup restore, project deletion, and non-production environment deletion. Resolve schema/backup/environment-based mutations to an immutable project ID before locking. New-project creation and other non-default environment mutations keep their existing path because no compatibility migration exists yet or the public actor migration covers only the default schema.
- [x] Keep lock ownership at public mutation boundaries and expose non-locking internal primitives for already-locked orchestration. Add a test that migration and wrapped management paths do not attempt nested acquisition on a second pool client.
- [x] Ensure project deletion passes through the ordinary persisted-state gate before any side effect. Keep an explicit service assertion close to destructive cleanup and the database delete trigger as defense in depth. Test that blocked deletion never invokes database-user, Hasura, schema, storage, or backup cleanup.
- [x] Map `DataAccessMutationLockedError` and the typed project-deletion preflight error to a sanitized `409 DATA_ACCESS_MIGRATION_IN_PROGRESS` response in each affected request handler. Map only SQLSTATE `55006` plus `druvia_data_access_migrations_inflight_delete_guard` to the same response in project and tenant deletion; rethrow every other database failure. Read-only routes and metadata reload do not acquire the lock.
- [x] Test lock mode, conflict responses, and release for Data Access, Realtime, table create/drop/sync, project deletion, environment deletion, exclusive raw SQL import, and clean backup restore. Add tenant-controller tests for a successful cascade, missing tenant, the exact guarded-delete conflict, and unrelated error propagation. Document that direct SQL/Hasura changes remain externally coordinated.
- [x] Run repository, mutation-lock, data-access service, project controller/service, tenant controller, environment routes/service, table controller/service, SQL, backup, and Realtime controller tests.

### Task 4: Add Read-Only Verification

- [x] Add verifier tests for exact metadata before and after cutover, extra permission and unsupported actor-binding drift, Hasura default normalization, internal HTTP actor headers and root visibility, compatibility aggregate roots, internal WebSocket URL/token use, acknowledgment, and connection cleanup when a later actor fails.
- [x] Run the verifier test and confirm the missing-module failure.
- [x] Add `graphql-ws` and `ws` to `apps/api/package.json`, plus `@types/ws` as a development dependency. Update the lockfile with pnpm.
- [x] Implement `data-access-migration-verifier.ts` with injected `fetch` and WebSocket factory seams for tests. Use the internal Hasura HTTP/WebSocket endpoints, five-second timeouts, and always dispose clients.
- [x] Extend `realtime-token.service.ts` only if needed to issue an internal token from a trusted `RealtimeExecutionContext`; do not add a new secret or token type.
- [x] Run:

```bash
pnpm vitest run \
  tests/unit/data-access-migration-verifier.test.ts \
  tests/unit/realtime-token-service.test.ts \
  tests/integration/realtime-token.test.ts
```

The existing Realtime integration test may require the local PostgreSQL/Hasura stack. Unit tests must remain runnable without it.

### Task 5: Implement Preview, Apply, Recovery, And Rollback

- [x] Add service tests for preview validation, stale digest and confirmation failures, apply stage ordering, source restoration, recovery-required source recovery, rollback preview/success, applied-state restoration, and recovery-required applied recovery. Real metadata failure injection remains covered by the local integration test.
- [x] Run the service test and confirm the missing-module failure.
- [x] Implement `data-access-migration.service.ts` with dependency-injected repository/metadata/verifier defaults so tests assert ordering without network calls.
- [x] Build replacement commands from snapshot and plan rather than mutating exported metadata objects in place.
- [x] Mark the phase before each external side effect and sanitize persisted/returned errors.
- [x] Ensure recovery selects `source_snapshot`/`compatibility` or `applied_snapshot`/`explicit` strictly from persisted `recovery_target`, re-exports current metadata, and computes a drop/create diff for only project-schema `user`, `anonymous`, and current project scoped-role permissions; preserve unrelated roles and table metadata and avoid unconditional drop commands.
- [x] Run the service tests plus existing data access, HTTP actor, and Realtime actor tests.

### Task 6: Expose Guarded Management Endpoints

- [x] Add controller and app-route tests for status, preview, apply, recovery, rollback preview, and rollback routing; platform-user authentication; migration identity/body forwarding; error status mapping; and absence of snapshot/role/metadata fields in JSON responses. Service tests own migration state, recovery-target, ownership, and confirmation validation.
- [x] Run the controller tests and observe route/controller failures.
- [x] Add controller handlers and route registrations. Reuse one management-access helper instead of copying authorization branches.
- [x] Extend `tests/unit/api-app.test.ts` to assert registration and authentication behavior through `buildApp()`.
- [x] Run:

```bash
pnpm vitest run \
  tests/unit/data-access-migration-controller.test.ts \
  tests/unit/api-app.test.ts \
  tests/unit/data-access-service.test.ts
```

### Task 7: Add Admin Types And API Client Methods

- [x] Add pure presentation tests for phase labels, monotonic stage progress, alias-confirmation requirements, and business-facing actor access summaries. Component tests own apply eligibility, independent confirmations, recovery presentation, and workflow behavior.
- [x] Run the tests and confirm the missing helper failure.
- [x] Implement `apps/admin/src/lib/project-data-access-migration.ts` with public report types and pure presentation helpers.
- [x] Add `getDataAccessMigration`, `previewDataAccessMigration`, `applyDataAccessMigration`, `recoverDataAccessMigration`, `previewDataAccessMigrationRollback`, and `rollbackDataAccessMigration` to `apps/admin/src/lib/api.ts`.
- [x] Do not log request bodies containing confirmation aliases or migration digests.
- [x] Rerun the focused helper and Admin API contract tests.

### Task 8: Build The Migration Panel And Dialogs

- [x] Add jsdom component tests for the compatibility entry point, independent confirmations, persisted progress/recovery target, disconnected-request status reconciliation, fresh-preview eligibility after terminal states, and confirmation reset when the migration ID changes. Pure presentation helpers cover phase labels and business-facing access summaries; blocker remediation links are rendered directly by the component.
- [x] Run the component test and confirm the missing component failure.
- [x] Implement `ProjectDataAccessMigration.tsx` using existing `Button`, `Badge`, `Dialog`, `Input`, and Lucide icons. Use an unframed full-width status band on the page and dialogs for the migration tool.
- [x] Integrate it above `ProjectDataAccessOverviewPanel` on the existing page. The page loads overview and migration status together and refreshes both after apply/rollback.
- [x] Poll status every second only while `applying` or `rolling_back`; clear timers on unmount and terminal state.
- [x] Keep dialog dimensions stable, controls visible, and table summaries stacked responsively on mobile.
- [x] Update the existing overview-panel compatibility expectation to the new migration copy.
- [x] Run all Data Access Admin unit tests.

### Task 9: Add Real Hasura Migration Integration Coverage

- [x] Write `tests/integration/data-access-migration.test.ts` before changing release gates. Reuse the fixture cleanup discipline from `realtime-token.test.ts`.
- [x] Create two temporary compatibility projects, tables, exact legacy permissions, and scoped owner/read policies.
- [x] Assert preview classification, destructive anonymous-write and aggregation reporting, apply, applied snapshot persistence, explicit actor resolution plus HTTP visibility, absence of the authenticated aggregate root, Realtime acknowledgment, absence of cross-project roots, project-local legacy removal while the second project's legacy permissions remain intact, rollback preview, rollback, and exact source restoration.
- [x] Add failure fixtures that inject verifier rejection after scoped preparation and during rollback restoration; assert automatic restoration to the correct source or applied digest and mode.
- [x] Run the integration file against the local stack. If the local stack is unavailable, report it explicitly; do not replace it with a passing mock assertion.

### Task 10: Update Release Gates And Documentation

- [x] Add the Batch 4 schema, classifier, planner, repository/lock, service, controller, verifier, Admin, management-mutation lock regressions, tenant delete guard, and existing actor regression tests to `.github/workflows/release.yml` before image build.
- [x] Keep actual publish and OTA rehearsal deferred; do not trigger the workflow.
- [x] Update root/API/Admin `AGENTS.md` only with stable security and ownership rules introduced by Batch 4.
- [x] Add `docs/004-project-data-access-migration-guide.md` for deployment operators, including metadata backup, custom-rule remediation, recovery-required handling, migration `019` prerequisites, and rollback risk. Keep raw metadata work out of the normal Admin workflow.
- [x] Update `docs/agent/design-decisions.md`, Supabase compatibility, version release guide, the parent Project Data Access design status, and `docs/progress.md`. Reconcile the parent design's broad “exported metadata backup” wording with this slice's immutable project-scoped permission snapshots plus an operator-created full backup before manual remediation.
- [x] Record that custom legacy rules remain blocked, anonymous writes are intentionally not migrated, rollback can restore legacy risk, and migration `019` must precede Batch 4 API use.
- [x] Update this document status and checkboxes with actual verification evidence after implementation.

## 15. Verification Commands

Focused suite:

```bash
pnpm vitest run \
  tests/unit/data-access-migration-schema.test.ts \
  tests/unit/data-access-migration-inspection.test.ts \
  tests/unit/data-access-migration-plan.test.ts \
  tests/unit/data-access-migration-repository.test.ts \
  tests/unit/data-access-mutation-lock.test.ts \
  tests/unit/data-access-migration-verifier.test.ts \
  tests/unit/data-access-migration-service.test.ts \
  tests/unit/data-access-migration-controller.test.ts \
  tests/unit/admin/project-data-access-migration.test.ts \
  tests/unit/admin/project-data-access-migration-panel.test.tsx \
  tests/unit/api-app.test.ts
```

Adjacent regressions:

```bash
pnpm vitest run \
  tests/unit/data-access-service.test.ts \
  tests/unit/data-access-inspection.test.ts \
  tests/unit/data-access-policy.test.ts \
  tests/unit/project-controller.test.ts \
  tests/unit/project-service.test.ts \
  tests/unit/tenant-controller.test.ts \
  tests/unit/environment-service.test.ts \
  tests/unit/table-controller.test.ts \
  tests/unit/table-service.test.ts \
  tests/unit/sql-controller.test.ts \
  tests/unit/sql-service.test.ts \
  tests/unit/backup-service.test.ts \
  tests/unit/backup-command.test.ts \
  tests/unit/realtime-controller.test.ts \
  tests/unit/project-data-actor.test.ts \
  tests/unit/realtime-actor.test.ts \
  tests/unit/realtime-token-service.test.ts \
  tests/unit/admin/project-data-access-overview-panel.test.tsx
```

Builds:

```bash
pnpm --filter @druvia/shared build
pnpm --filter @druvia/api build
pnpm --filter @druvia/admin build
```

Local integration, when PostgreSQL and Hasura are available and migration `019` is applied:

```bash
DRUVIA_RUN_DATA_ACCESS_MIGRATION_INTEGRATION=1 \
DRUVIA_INTEGRATION_HASURA_ADMIN_SECRET='<running-admin-secret>' \
DRUVIA_INTEGRATION_HASURA_JWT_SECRET='<running-verifier-key>' \
pnpm vitest run tests/integration/data-access-migration.test.ts
```

Final static checks:

```bash
git diff --check
test ! -d docs/superpowers
```

No GitHub Action dispatch, image publication, Registry pull, production host operation, or OTA apply belongs to this verification set.

The release workflow defaults both GHCR and self-hosted manifests to migration range `18 -> 19`, requires a pre-migration backup, and marks the migration non-reversible. Tag-triggered releases use the same defaults when no manual inputs exist. Future migrations must advance these defaults and the release-pipeline contract test together.

## 16. Verification Evidence

Verified on 2026-08-18 against the local PostgreSQL 17 and Hasura v2.48 stack:

- `pnpm test -- tests/unit tests/sdk tests/api`: 111 files, 717 tests passed.
- Exact Batch 4 release workflow step: 30 files, 183 tests passed.
- `@druvia/shared`, `@druvia/api`, and `@druvia/admin` production builds passed.
- `pnpm migrate status` reports current local schema version `19` with migration `019` applied.
- `data-access-migration.test.ts`: apply, rollback, source restoration, applied restoration, cross-project isolation, HTTP roots, and Realtime acknowledgment passed against real services.
- `realtime-token.test.ts`: 8 real Hasura token/WebSocket cases passed with the running verifier contract.
- Post-test database audit found zero migration/realtime test tenants and zero active or recovery-required migration rows.

The repository-wide bare `pnpm test` command still includes older shared-database integration suites that are not isolated for concurrent execution. Batch 4 acceptance therefore uses the deterministic no-dependency suite plus separately serialized real-service integration files; this does not claim that every historical integration file is a clean parallel gate.

## 17. Acceptance Criteria

- Existing compatibility projects can generate a persisted, deterministic migration preview.
- Custom legacy/scoped rules block activation and are never silently overwritten or deleted.
- Exact authenticated defaults and anonymous reads receive reviewed project-scoped equivalents, while operators can preserve closed targets per table when metadata cannot prove prior intent.
- Inferred operations and aggregation removal are never applied without explicit review, confirmation, and project alias entry.
- Anonymous writes are removed only after explicit destructive confirmation and alias entry.
- Metadata drift blocks apply and rollback.
- An interrupted active or recovery-required record continues to block conflicting managed writes after process locks disappear; it blocks replacement previews and project/tenant deletion until the operation reaches a verified terminal state.
- Druvia-owned project schema, permission, Realtime-context, restore, and deletion mutations return a stable conflict while migration holds the ordered locks; raw SQL import, full `replace_metadata`, cascade deletion, and clean restore paths are globally serialized against those mutations.
- Apply verifies project-scoped HTTP and Realtime behavior without mutating application data.
- Legacy permissions are removed before the project becomes explicit.
- Every apply failure either restores the exact source digest or reports recovery required.
- Every rollback failure either restores the persisted applied digest and explicit mode or reports rollback recovery required.
- Explicit recovery follows the persisted recovery target and cannot restore the wrong side of the migration.
- Successful migrations can be rolled back only while the applied digest remains current.
- Admin never exposes Hasura secrets, raw metadata, or generated role names.
- Unit tests, local integration tests, API/Admin builds, and release static gates pass.
- Actual release and OTA testing remains deferred as requested.
