import type { ProjectDataAccessMode } from '@druvia/shared'
import type { DataAccessRoleNames, TableDataAccessInput } from './data-access.types.js'

export type DataAccessMigrationOperation = 'select' | 'insert' | 'update' | 'delete'
export type DataAccessMigrationActor = 'authenticated' | 'anonymous' | 'system'
export type DataAccessMigrationStatus =
  | 'preview_ready'
  | 'applying'
  | 'applied'
  | 'rolling_back'
  | 'rolled_back'
  | 'recovered'
  | 'failed'
  | 'superseded'
export type DataAccessMigrationPhase =
  | 'preview'
  | 'snapshot_check'
  | 'prepare_scoped_permissions'
  | 'verify_scoped_metadata'
  | 'verify_scoped_http'
  | 'verify_scoped_realtime'
  | 'remove_legacy_permissions'
  | 'activate_explicit_mode'
  | 'verify_active_runtime'
  | 'rollback_snapshot_check'
  | 'restore_permissions'
  | 'restore_runtime_mode'
  | 'verify_recovery_target'
  | 'completed'

export interface MigrationPermissionSnapshot {
  operation: DataAccessMigrationOperation
  role: string
  permission: Record<string, unknown>
}

export interface MigrationTableSnapshot {
  tableName: string
  columns: string[]
  insertableColumns?: string[]
  updateableColumns?: string[]
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
  runtimeMode: ProjectDataAccessMode
  sourceGraphqlNaming: Record<string, unknown> | null
  tables: MigrationTableSnapshot[]
  unsupportedApiBindings: Array<{
    kind:
      | 'function'
      | 'native_query'
      | 'logical_model'
      | 'stored_procedure'
      | 'action'
      | 'remote_schema'
      | 'inherited_role'
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
  actor: DataAccessMigrationActor
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
  actor: Exclude<DataAccessMigrationActor, 'system'>
  operation: DataAccessMigrationOperation
  reason: 'anonymous_write_removed' | 'authenticated_aggregations_removed'
}

export interface MigrationTargetPolicy {
  tableName: string
  source: 'existing_scoped' | 'legacy_default' | 'mixed' | 'closed'
  inferredOperations: Array<{
    actor: Exclude<DataAccessMigrationActor, 'system'>
    operation: DataAccessMigrationOperation
  }>
  policy: TableDataAccessInput
}

export interface ProjectDataAccessMigrationPlan {
  version: 1 | 2
  projectId: string
  schemaName: string
  targetPolicies: MigrationTargetPolicy[]
  legacyDrops: Array<{
    tableName: string
    role: 'user' | 'anonymous'
    operation: DataAccessMigrationOperation
  }>
  blockers: DataAccessMigrationBlocker[]
  destructiveChanges: DataAccessMigrationDestructiveChange[]
}

export interface BuildProjectMigrationSnapshotInput {
  projectId: string
  schemaName: string
  runtimeMode: ProjectDataAccessMode
  roles: DataAccessRoleNames
  inventory: Array<{
    tableName: string
    columns: string[]
    insertableColumns: string[]
    updateableColumns: string[]
    realtimeEnabled: boolean
  }>
  source: Record<string, unknown>
  metadata: Record<string, unknown>
}

export interface MigrationReportRecord {
  migrationId: string
  projectId: string
  status: DataAccessMigrationStatus
  phase: DataAccessMigrationPhase
  sourceDigest: string
  appliedDigest: string | null
  recoveryTarget: 'source' | 'applied' | null
  appliedAt: string | null
  rollbackPreviewDigest: string | null
  error: { code: string; message: string } | null
  plan: ProjectDataAccessMigrationPlan
}

export interface ProjectDataAccessMigrationReport {
  migrationId: string
  projectId: string
  status: DataAccessMigrationStatus
  phase: DataAccessMigrationPhase
  sourceDigest: string
  rollbackPreviewDigest: string | null
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
    targetSource: MigrationTargetPolicy['source']
    inferredOperations: MigrationTargetPolicy['inferredOperations']
    authenticated: 'closed' | 'read_only' | 'write_only' | 'read_write'
    anonymousRead: boolean
    removesAnonymousWrite: boolean
    removesAuthenticatedAggregations: boolean
    blocked: boolean
  }>
  error: { code: string; message: string } | null
}
