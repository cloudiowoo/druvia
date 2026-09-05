import { createClosedTableDataAccessPolicy } from './data-access-policy.js'
import { inspectTableDataAccessMetadata, type HasuraTableMetadata } from './data-access-inspection.js'
import type { DataAccessRoleNames } from './data-access.types.js'
import { getStoredColumnCapabilities } from './data-access-column-capabilities.js'
import type {
  DataAccessMigrationBlocker,
  DataAccessMigrationDestructiveChange,
  DataAccessMigrationOperation,
  MigrationTableSnapshot,
  MigrationTargetPolicy,
  ProjectDataAccessMigrationPlan,
} from './data-access-migration.types.js'

const OPERATIONS: DataAccessMigrationOperation[] = ['select', 'insert', 'update', 'delete']

export interface InspectedMigrationTable extends MigrationTargetPolicy {
  blockers: DataAccessMigrationBlocker[]
  destructiveChanges: DataAccessMigrationDestructiveChange[]
  legacyDrops: ProjectDataAccessMigrationPlan['legacyDrops']
}

export function inspectMigrationTable(
  table: MigrationTableSnapshot,
  roles: DataAccessRoleNames,
  options: { skipLegacyInference?: boolean } = {}
): InspectedMigrationTable {
  const policy = createClosedTableDataAccessPolicy()
  const blockers: DataAccessMigrationBlocker[] = []
  const destructiveChanges: DataAccessMigrationDestructiveChange[] = []
  const legacyDrops: ProjectDataAccessMigrationPlan['legacyDrops'] = []
  const inferredOperations: MigrationTargetPolicy['inferredOperations'] = []
  const scopedPermissions = table.permissions.filter((item) => (
    item.role === roles.authenticated || item.role === roles.anonymous
  ))
  const legacyPermissions = table.permissions.filter((item) => (
    item.role === 'user' || item.role === 'anonymous'
  ))

  const duplicateKeys = new Set<string>()
  for (const permission of [...scopedPermissions, ...legacyPermissions]) {
    const key = `${permission.role}:${permission.operation}`
    if ([...scopedPermissions, ...legacyPermissions].filter(
      (item) => `${item.role}:${item.operation}` === key
    ).length > 1) duplicateKeys.add(key)
  }
  for (const key of [...duplicateKeys].sort()) {
    const [role, operation] = key.split(':') as [string, DataAccessMigrationOperation]
    blockers.push({
      tableName: table.tableName,
      actor: role === 'user' || role === roles.authenticated ? 'authenticated' : 'anonymous',
      operation,
      reason: 'duplicate_rule',
    })
  }

  const capabilities = getStoredColumnCapabilities(table)
  const scopedMetadata = toHasuraTableMetadata(table, scopedPermissions)
  const scoped = inspectTableDataAccessMetadata(scopedMetadata, roles, capabilities)
  const hasScopedAuthenticated = scopedPermissions.some((item) => item.role === roles.authenticated)
  const hasScopedAnonymous = scopedPermissions.some((item) => item.role === roles.anonymous)
  if (hasScopedAuthenticated && scoped.authenticatedState === 'custom') {
    addScopedBlockers(blockers, table, roles.authenticated, scopedPermissions)
  }
  if (hasScopedAnonymous && scoped.anonymousState === 'custom') {
    addScopedBlockers(blockers, table, roles.anonymous, scopedPermissions)
  }

  if (scoped.authenticatedState === 'managed') {
    policy.authenticated = { ...scoped.policy.authenticated }
  }
  if (scoped.anonymousState === 'managed') {
    policy.anonymous = { ...scoped.policy.anonymous }
  }

  for (const legacy of legacyPermissions) {
    legacyDrops.push({
      tableName: table.tableName,
      role: legacy.role as 'user' | 'anonymous',
      operation: legacy.operation,
    })
    if (duplicateKeys.has(`${legacy.role}:${legacy.operation}`)) continue

    const classification = classifyHistoricalPermission(
      legacy.role,
      legacy.operation,
      legacy.permission,
      capabilities
    )
    const actor = legacy.role === 'user' ? 'authenticated' : 'anonymous'
    if (!classification.recognized) {
      blockers.push({
        tableName: table.tableName,
        actor,
        operation: legacy.operation,
        reason: 'custom_legacy_rule',
      })
      continue
    }

    if (actor === 'anonymous' && legacy.operation !== 'select') {
      destructiveChanges.push({
        tableName: table.tableName,
        actor,
        operation: legacy.operation,
        reason: 'anonymous_write_removed',
      })
      continue
    }

    if (classification.removesAggregations) {
      destructiveChanges.push({
        tableName: table.tableName,
        actor: 'authenticated',
        operation: 'select',
        reason: 'authenticated_aggregations_removed',
      })
    }
    if (options.skipLegacyInference) continue

    if (actor === 'authenticated' && policy.authenticated[legacy.operation] === 'none') {
      policy.authenticated[legacy.operation] = 'all'
      inferredOperations.push({ actor, operation: legacy.operation })
    }
    if (actor === 'anonymous' && legacy.operation === 'select' && !policy.anonymous.select) {
      policy.anonymous.select = true
      inferredOperations.push({ actor, operation: 'select' })
    }
  }

  if (table.inventoryStatus === 'tracked_only' && (scopedPermissions.length > 0 || legacyPermissions.length > 0)) {
    blockers.push({
      tableName: table.tableName,
      actor: 'system',
      operation: null,
      reason: 'unsupported_tracked_object',
    })
  }

  const hasScoped = scopedPermissions.length > 0
  const hasInferred = inferredOperations.length > 0
  return {
    tableName: table.tableName,
    source: hasScoped && hasInferred
      ? 'mixed'
      : hasScoped
        ? 'existing_scoped'
        : hasInferred
          ? 'legacy_default'
          : 'closed',
    policy,
    inferredOperations,
    blockers: dedupeAndSortBlockers(blockers),
    destructiveChanges: sortChanges(destructiveChanges),
    legacyDrops: [...legacyDrops].sort(compareLegacyDrop),
  }
}

function classifyHistoricalPermission(
  role: string,
  operation: DataAccessMigrationOperation,
  permission: Record<string, unknown>,
  capabilities: ReturnType<typeof getStoredColumnCapabilities>
): { recognized: boolean; removesAggregations: boolean } {
  const allowed = operation === 'select'
    ? ['columns', 'filter', 'allow_aggregations', 'backend_only']
    : operation === 'insert'
      ? ['columns', 'check', 'set', 'backend_only']
      : operation === 'update'
        ? ['columns', 'filter', 'check', 'set', 'backend_only']
        : ['filter', 'backend_only']
  if (Object.keys(permission).some((key) => !allowed.includes(key))) return { recognized: false, removesAggregations: false }
  if (permission.backend_only !== undefined && permission.backend_only !== false) return { recognized: false, removesAggregations: false }
  const operationColumns = operation === 'select'
    ? capabilities.readableColumns
    : operation === 'insert'
      ? capabilities.insertableColumns
      : capabilities.updateableColumns
  if (operation !== 'delete' && !allColumns(permission.columns, operationColumns)) {
    return { recognized: false, removesAggregations: false }
  }
  if (operation !== 'insert' && !emptyObject(permission.filter)) return { recognized: false, removesAggregations: false }
  if (operation === 'insert' && !emptyObject(permission.check)) return { recognized: false, removesAggregations: false }
  if (operation === 'update' && !emptyOrMissing(permission.check)) return { recognized: false, removesAggregations: false }
  if ((operation === 'insert' || operation === 'update') && !emptyOrMissing(permission.set)) {
    return { recognized: false, removesAggregations: false }
  }
  if (operation === 'select') {
    const aggregation = permission.allow_aggregations
    if (aggregation !== undefined && aggregation !== false && aggregation !== true) {
      return { recognized: false, removesAggregations: false }
    }
    if (aggregation === true && role !== 'user') {
      return { recognized: false, removesAggregations: false }
    }
    return { recognized: true, removesAggregations: role === 'user' && aggregation === true }
  }
  return { recognized: true, removesAggregations: false }
}

function toHasuraTableMetadata(
  table: MigrationTableSnapshot,
  permissions: MigrationTableSnapshot['permissions']
): HasuraTableMetadata {
  const metadata: HasuraTableMetadata = { table: { schema: '', name: table.tableName } }
  for (const operation of OPERATIONS) {
    metadata[`${operation}_permissions`] = permissions
      .filter((item) => item.operation === operation)
      .map(({ role, permission }) => ({ role, permission }))
  }
  return metadata
}

function addScopedBlockers(
  blockers: DataAccessMigrationBlocker[],
  table: MigrationTableSnapshot,
  role: string,
  permissions: MigrationTableSnapshot['permissions']
): void {
  const actor = role.endsWith('_anon') ? 'anonymous' : 'authenticated'
  const operations = permissions
    .filter((item) => item.role === role)
    .map((item) => item.operation)
  for (const operation of [...new Set(operations)].sort()) {
    blockers.push({ tableName: table.tableName, actor, operation, reason: 'custom_scoped_rule' })
  }
}

function allColumns(value: unknown, columns: string[]): boolean {
  if (value === '*') return true
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string')
    && new Set(value).size === new Set(columns).size
    && columns.every((column) => value.includes(column))
}

function emptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

function emptyOrMissing(value: unknown): boolean {
  return value === undefined || value === null || emptyObject(value)
}

function dedupeAndSortBlockers(blockers: DataAccessMigrationBlocker[]): DataAccessMigrationBlocker[] {
  return [...new Map(blockers.map((item) => [JSON.stringify(item), item])).values()]
    .sort((a, b) => `${a.tableName}:${a.actor}:${a.operation}:${a.reason}`.localeCompare(
      `${b.tableName}:${b.actor}:${b.operation}:${b.reason}`
    ))
}

function sortChanges(changes: DataAccessMigrationDestructiveChange[]): DataAccessMigrationDestructiveChange[] {
  return [...changes].sort((a, b) => `${a.tableName}:${a.actor}:${a.operation}:${a.reason}`.localeCompare(
    `${b.tableName}:${b.actor}:${b.operation}:${b.reason}`
  ))
}

function compareLegacyDrop(
  a: ProjectDataAccessMigrationPlan['legacyDrops'][number],
  b: ProjectDataAccessMigrationPlan['legacyDrops'][number]
): number {
  return `${a.tableName}:${a.role}:${a.operation}`.localeCompare(`${b.tableName}:${b.role}:${b.operation}`)
}
