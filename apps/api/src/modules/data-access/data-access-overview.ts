import { inspectTableDataAccessMetadata, type HasuraTableMetadata } from './data-access-inspection.js'
import type { ProjectDataAccessMode } from '@druvia/shared'
import type { DataAccessInventoryTable } from './data-access-inventory.js'
import { getInventoryColumnCapabilities } from './data-access-column-capabilities.js'
import type {
  AnonymousAccessStatus,
  AuthenticatedAccessStatus,
  DataAccessRealtimeStatus,
  DataAccessRoleNames,
  ProjectDataAccessOverview,
  ProjectTableDataAccessOverview,
} from './data-access.types.js'

interface BuildProjectDataAccessOverviewInput {
  projectId: string
  schemaName: string
  runtimeMode: ProjectDataAccessMode
  roles: DataAccessRoleNames
  inventory: DataAccessInventoryTable[]
  tableMetadata: HasuraTableMetadata[]
}

export function buildProjectDataAccessOverview(
  input: BuildProjectDataAccessOverviewInput
): ProjectDataAccessOverview {
  const metadataByTable = new Map(
    input.tableMetadata
      .filter((item) => item.table.schema === input.schemaName)
      .map((item) => [item.table.name, item])
  )
  const builtTables = [...input.inventory]
    .sort((left, right) => left.tableName.localeCompare(right.tableName))
    .map((item) => buildTableOverview(item, metadataByTable.get(item.tableName), input.roles))
  const tables = builtTables.map((item) => item.table)

  return {
    projectId: input.projectId,
    schemaName: input.schemaName,
    runtimeMode: input.runtimeMode,
    summary: {
      totalTables: tables.length,
      configuredTables: builtTables.filter((item) => item.hasSupportedPermission).length,
      anonymousConfiguredTables: builtTables.filter((item) => item.hasAnonymousRead).length,
      realtimeAccessRequiredTables: tables.filter(
        (item) => item.realtime === 'access_required'
      ).length,
      legacyTables: tables.filter(
        (item) => item.legacyAccess.authenticated || item.legacyAccess.anonymous
      ).length,
      reviewRequiredTables: tables.filter((item) => item.reviewRequired).length,
    },
    tables,
  }
}

function buildTableOverview(
  inventory: DataAccessInventoryTable,
  metadata: HasuraTableMetadata | undefined,
  roles: DataAccessRoleNames
): {
  table: ProjectTableDataAccessOverview
  hasSupportedPermission: boolean
  hasAnonymousRead: boolean
} {
  const inspected = inspectTableDataAccessMetadata(
    metadata ?? null,
    roles,
    getInventoryColumnCapabilities(inventory)
  )
  const hasAuthenticatedRead = inspected.policy.authenticated.select !== 'none'
  const hasAuthenticatedWrite = ['insert', 'update', 'delete'].some(
    (operation) => inspected.policy.authenticated[
      operation as 'insert' | 'update' | 'delete'
    ] !== 'none'
  )
  const hasAnonymousRead = inspected.policy.anonymous.select
  const legacyAccess = {
    authenticated: inspected.legacyRoles.includes('user'),
    anonymous: inspected.legacyRoles.includes('anonymous'),
  }
  const reviewRequired = !metadata
    || inspected.authenticatedState === 'custom'
    || inspected.anonymousState === 'custom'
    || legacyAccess.authenticated
    || legacyAccess.anonymous

  return {
    table: {
      tableName: inventory.tableName,
      dataInterface: metadata ? 'connected' : 'not_connected',
      authenticatedAccess: classifyAuthenticatedAccess(
        inspected.authenticatedState,
        hasAuthenticatedRead,
        hasAuthenticatedWrite
      ),
      anonymousAccess: classifyAnonymousAccess(
        inspected.anonymousState,
        hasAnonymousRead
      ),
      realtime: classifyRealtime(
        inventory.realtimeEnabled,
        hasAuthenticatedRead || hasAnonymousRead
      ),
      legacyAccess,
      reviewRequired,
    },
    hasSupportedPermission: hasAuthenticatedRead || hasAuthenticatedWrite || hasAnonymousRead,
    hasAnonymousRead,
  }
}

function classifyAuthenticatedAccess(
  state: 'managed' | 'custom',
  hasRead: boolean,
  hasWrite: boolean
): AuthenticatedAccessStatus {
  if (state === 'custom') return 'custom'
  if (hasRead && hasWrite) return 'read_write'
  if (hasRead) return 'read_only'
  if (hasWrite) return 'write_only'
  return 'closed'
}

function classifyAnonymousAccess(
  state: 'managed' | 'custom',
  hasRead: boolean
): AnonymousAccessStatus {
  if (state === 'custom') return 'custom'
  return hasRead ? 'read' : 'closed'
}

function classifyRealtime(
  enabled: boolean,
  hasManagedRead: boolean
): DataAccessRealtimeStatus {
  if (!enabled) return 'disabled'
  return hasManagedRead ? 'configured' : 'access_required'
}
