import { createHash } from 'node:crypto'
import { inspectMigrationTable } from './data-access-migration-inspection.js'
import type { DataAccessRoleNames } from './data-access.types.js'
import type {
  BuildProjectMigrationSnapshotInput,
  DataAccessMigrationBlocker,
  DataAccessMigrationOperation,
  MigrationPermissionSnapshot,
  MigrationReportRecord,
  MigrationTableSnapshot,
  ProjectDataAccessMigrationPlan,
  ProjectDataAccessMigrationReport,
  ProjectDataAccessMigrationSnapshot,
} from './data-access-migration.types.js'

const OPERATIONS: DataAccessMigrationOperation[] = ['select', 'insert', 'update', 'delete']

export function canonicalizeMigrationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeMigrationValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeMigrationValue(item)])
  )
}

export function digestMigrationValue(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeMigrationValue(value)))
    .digest('hex')
}

export function digestProjectMigrationSnapshot(
  snapshot: ProjectDataAccessMigrationSnapshot,
  version: ProjectDataAccessMigrationPlan['version'] = 2
): string {
  if (version === 2) return digestMigrationValue(snapshot)
  return digestMigrationValue({
    ...snapshot,
    tables: snapshot.tables.map(({ insertableColumns: _insert, updateableColumns: _update, ...table }) => table),
  })
}

export function buildProjectMigrationSnapshot(
  input: BuildProjectMigrationSnapshotInput
): ProjectDataAccessMigrationSnapshot {
  const source = input.source
  const sourceTables = arrayOfRecords(source.tables)
  const inventory = new Map(input.inventory.map((item) => [item.tableName, item]))
  const projectTables = sourceTables.filter((item) => tableIdentity(item).schema === input.schemaName)
  const tables: MigrationTableSnapshot[] = projectTables.map((item) => {
    const identity = tableIdentity(item)
    const known = inventory.get(identity.name)
    return normalizeTableSnapshot(item, identity.name, known)
  })

  const trackedNames = new Set(tables.map((item) => item.tableName))
  for (const item of input.inventory) {
    if (trackedNames.has(item.tableName)) continue
    tables.push({
      tableName: item.tableName,
      columns: sortedUnique(item.columns),
      insertableColumns: sortedUnique(item.insertableColumns),
      updateableColumns: sortedUnique(item.updateableColumns),
      realtimeEnabled: item.realtimeEnabled,
      graphqlNaming: { customName: null, customRootFields: {} },
      inventoryStatus: 'managed_table',
      permissions: [],
    })
  }

  const relevantRoles = new Set(['user', 'anonymous', input.roles.authenticated, input.roles.anonymous])
  const externalScopedRoleBindings = sourceTables
    .filter((item) => tableIdentity(item).schema !== input.schemaName)
    .flatMap((item) => extractPermissions(item)
      .filter((permission) => permission.role === input.roles.authenticated || permission.role === input.roles.anonymous)
      .map((permission) => ({
        schemaName: tableIdentity(item).schema,
        tableName: tableIdentity(item).name,
        role: permission.role,
        operation: permission.operation,
      })))
    .sort(compareJson)

  return {
    projectId: input.projectId,
    schemaName: input.schemaName,
    runtimeMode: input.runtimeMode,
    sourceGraphqlNaming: normalizeSourceCustomization(source.customization),
    tables: tables.sort((a, b) => a.tableName.localeCompare(b.tableName)),
    unsupportedApiBindings: extractUnsupportedBindings(source, input.metadata, relevantRoles),
    externalScopedRoleBindings,
  }
}

export function buildProjectMigrationPlan(
  snapshot: ProjectDataAccessMigrationSnapshot,
  roles: DataAccessRoleNames,
  options: { skipLegacyInferenceTables?: string[] } = {}
): ProjectDataAccessMigrationPlan {
  const targetPolicies: ProjectDataAccessMigrationPlan['targetPolicies'] = []
  const legacyDrops: ProjectDataAccessMigrationPlan['legacyDrops'] = []
  const blockers: ProjectDataAccessMigrationPlan['blockers'] = []
  const destructiveChanges: ProjectDataAccessMigrationPlan['destructiveChanges'] = []
  const skipped = new Set(options.skipLegacyInferenceTables ?? [])

  if (snapshot.sourceGraphqlNaming) {
    blockers.push({ tableName: null, actor: 'system', operation: null, reason: 'unsupported_source_customization' })
  }

  for (const table of snapshot.tables) {
    const inspected = inspectMigrationTable(table, roles, { skipLegacyInference: skipped.has(table.tableName) })
    if (table.inventoryStatus === 'managed_table') {
      targetPolicies.push({
        tableName: inspected.tableName,
        source: inspected.source,
        inferredOperations: inspected.inferredOperations,
        policy: inspected.policy,
      })
    }
    legacyDrops.push(...inspected.legacyDrops)
    blockers.push(...inspected.blockers)
    destructiveChanges.push(...inspected.destructiveChanges)
  }

  for (const binding of snapshot.unsupportedApiBindings) {
    blockers.push({ tableName: null, actor: actorForRole(binding.role, roles), operation: null, reason: 'unsupported_tracked_object' })
  }
  for (const binding of snapshot.externalScopedRoleBindings) {
    blockers.push({
      tableName: binding.tableName,
      actor: actorForRole(binding.role, roles),
      operation: binding.operation,
      reason: 'cross_project_role_binding',
    })
  }

  return {
    version: 2,
    projectId: snapshot.projectId,
    schemaName: snapshot.schemaName,
    targetPolicies: targetPolicies.sort((a, b) => a.tableName.localeCompare(b.tableName)),
    legacyDrops: legacyDrops.sort(compareJson),
    blockers: dedupe(blockers).sort(compareBlocker),
    destructiveChanges: destructiveChanges.sort(compareJson),
  }
}

export function toPublicMigrationReport(record: MigrationReportRecord): ProjectDataAccessMigrationReport {
  const managedTables = record.plan.targetPolicies
  const requiredRecoveryDigest = record.recoveryTarget === 'source'
    ? record.sourceDigest
    : record.recoveryTarget === 'applied'
      ? record.appliedDigest
      : null
  return {
    migrationId: record.migrationId,
    projectId: record.projectId,
    status: record.status,
    phase: record.phase,
    sourceDigest: record.sourceDigest,
    rollbackPreviewDigest: record.rollbackPreviewDigest,
    requiredRecoveryDigest,
    recoveryTarget: record.recoveryTarget === 'source'
      ? 'pre_migration'
      : record.recoveryTarget === 'applied'
        ? 'current_explicit'
        : null,
    appliedAt: record.appliedAt,
    canApply: record.plan.version === 2
      && record.status === 'preview_ready'
      && record.plan.blockers.length === 0,
    canRollback: record.status === 'applied',
    summary: {
      totalTables: managedTables.length,
      migratedTables: managedTables.filter((item) => item.inferredOperations.length > 0).length,
      preservedScopedTables: managedTables.filter((item) => item.source === 'existing_scoped' || item.source === 'mixed').length,
      inferredOperationCount: managedTables.reduce((total, item) => total + item.inferredOperations.length, 0),
      blockerCount: record.plan.blockers.length,
      destructiveChangeCount: record.plan.destructiveChanges.length,
    },
    blockers: record.plan.blockers,
    destructiveChanges: record.plan.destructiveChanges,
    tables: managedTables.map((item) => ({
      tableName: item.tableName,
      targetSource: item.source,
      inferredOperations: item.inferredOperations,
      authenticated: summarizeAuthenticated(item.policy),
      anonymousRead: item.policy.anonymous.select,
      removesAnonymousWrite: record.plan.destructiveChanges.some(
        (change) => change.tableName === item.tableName && change.reason === 'anonymous_write_removed'
      ),
      removesAuthenticatedAggregations: record.plan.destructiveChanges.some(
        (change) => change.tableName === item.tableName && change.reason === 'authenticated_aggregations_removed'
      ),
      blocked: record.plan.blockers.some((blocker) => blocker.tableName === item.tableName),
    })),
    error: record.error,
  }
}

function normalizeTableSnapshot(
  value: Record<string, unknown>,
  tableName: string,
  inventory: BuildProjectMigrationSnapshotInput['inventory'][number] | undefined
): MigrationTableSnapshot {
  const configuration = recordOf(value.configuration)
  const columns = sortedUnique(inventory?.columns ?? inferPermissionColumns(value))
  return {
    tableName,
    columns,
    insertableColumns: sortedUnique(inventory?.insertableColumns ?? columns),
    updateableColumns: sortedUnique(inventory?.updateableColumns ?? columns),
    realtimeEnabled: inventory?.realtimeEnabled ?? false,
    graphqlNaming: {
      customName: typeof configuration.custom_name === 'string' ? configuration.custom_name : null,
      customRootFields: stringRecord(configuration.custom_root_fields),
    },
    inventoryStatus: inventory ? 'managed_table' : 'tracked_only',
    permissions: extractPermissions(value),
  }
}

function extractPermissions(table: Record<string, unknown>): MigrationPermissionSnapshot[] {
  const permissions: MigrationPermissionSnapshot[] = []
  for (const operation of OPERATIONS) {
    for (const entry of arrayOfRecords(table[`${operation}_permissions`])) {
      if (typeof entry.role !== 'string') continue
      permissions.push({
        role: entry.role,
        operation,
        permission: normalizePermission(recordOf(entry.permission)),
      })
    }
  }
  return permissions.sort((a, b) => `${a.role}:${a.operation}`.localeCompare(`${b.role}:${b.operation}`))
}

function normalizePermission(permission: Record<string, unknown>): Record<string, unknown> {
  const result = { ...permission }
  if (Array.isArray(result.columns)) result.columns = sortedUnique(result.columns.filter((item): item is string => typeof item === 'string'))
  return canonicalizeMigrationValue(result) as Record<string, unknown>
}

function extractUnsupportedBindings(
  source: Record<string, unknown>,
  metadata: Record<string, unknown>,
  relevantRoles: Set<string>
): ProjectDataAccessMigrationSnapshot['unsupportedApiBindings'] {
  type UnsupportedBindingKind = ProjectDataAccessMigrationSnapshot['unsupportedApiBindings'][number]['kind']
  const collections: Array<[UnsupportedBindingKind, string]> = [
    ['function', 'functions'],
    ['native_query', 'native_queries'],
    ['logical_model', 'logical_models'],
    ['stored_procedure', 'stored_procedures'],
  ]
  const result: ProjectDataAccessMigrationSnapshot['unsupportedApiBindings'] = []
  for (const [kind, key] of collections) {
    for (const item of arrayOfRecords(source[key])) {
      const objectName = objectIdentity(item, kind)
      const roleEntries = [
        ...arrayOfRecords(item.permissions),
        ...arrayOfRecords(item.select_permissions),
      ]
      for (const permission of roleEntries) {
        if (typeof permission.role === 'string' && relevantRoles.has(permission.role)) {
          result.push({ kind, objectName, role: permission.role })
        }
      }
    }
  }

  for (const [kind, key] of [
    ['action', 'actions'],
    ['remote_schema', 'remote_schemas'],
  ] as const) {
    for (const item of arrayOfRecords(metadata[key])) {
      const objectName = typeof item.name === 'string' ? item.name : 'unknown'
      for (const permission of arrayOfRecords(item.permissions)) {
        if (typeof permission.role === 'string' && relevantRoles.has(permission.role)) {
          result.push({ kind, objectName, role: permission.role })
        }
      }
    }
  }

  for (const item of arrayOfRecords(metadata.inherited_roles)) {
    const objectName = typeof item.role_name === 'string' ? item.role_name : 'unknown'
    const boundRoles = [item.role_name, ...(Array.isArray(item.role_set) ? item.role_set : [])]
      .filter((role): role is string => typeof role === 'string' && relevantRoles.has(role))
    for (const role of new Set(boundRoles)) {
      result.push({ kind: 'inherited_role', objectName, role })
    }
  }
  return result.sort(compareJson)
}

function objectIdentity(value: Record<string, unknown>, kind: string): string {
  const identity = kind === 'function' || kind === 'stored_procedure'
    ? recordOf(value[kind])
    : value
  const schema = typeof identity.schema === 'string' ? identity.schema : ''
  const name = typeof identity.name === 'string' ? identity.name : 'unknown'
  return schema ? `${schema}.${name}` : name
}

function tableIdentity(value: Record<string, unknown>): { schema: string; name: string } {
  const table = recordOf(value.table)
  return {
    schema: typeof table.schema === 'string' ? table.schema : '',
    name: typeof table.name === 'string' ? table.name : '',
  }
}

function normalizeSourceCustomization(value: unknown): Record<string, unknown> | null {
  const normalized = canonicalizeMigrationValue(recordOf(value)) as Record<string, unknown>
  return Object.keys(normalized).length === 0 ? null : normalized
}

function inferPermissionColumns(table: Record<string, unknown>): string[] {
  return sortedUnique(extractPermissions(table).flatMap((item) => (
    Array.isArray(item.permission.columns)
      ? item.permission.columns.filter((column): column is string => typeof column === 'string')
      : []
  )))
}

function summarizeAuthenticated(policy: ProjectDataAccessMigrationPlan['targetPolicies'][number]['policy']): 'closed' | 'read_only' | 'write_only' | 'read_write' {
  const read = policy.authenticated.select !== 'none'
  const write = policy.authenticated.insert !== 'none'
    || policy.authenticated.update !== 'none'
    || policy.authenticated.delete !== 'none'
  if (read && write) return 'read_write'
  if (read) return 'read_only'
  if (write) return 'write_only'
  return 'closed'
}

function actorForRole(role: string, roles: DataAccessRoleNames): 'authenticated' | 'anonymous' | 'system' {
  if (role === 'user' || role === roles.authenticated) return 'authenticated'
  if (role === 'anonymous' || role === roles.anonymous) return 'anonymous'
  return 'system'
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : []
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(recordOf(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right))
}

function compareBlocker(left: DataAccessMigrationBlocker, right: DataAccessMigrationBlocker): number {
  return `${left.tableName}:${left.actor}:${left.operation}:${left.reason}`.localeCompare(
    `${right.tableName}:${right.actor}:${right.operation}:${right.reason}`
  )
}

function dedupe<T>(values: T[]): T[] {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()]
}
