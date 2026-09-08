import {
  inspectTableDataAccessMetadata,
  materializeInspectedTableDataAccess,
  type HasuraTableMetadata,
} from './data-access-inspection.js'
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
import type {
  ManagedPolicyRecord,
  PolicyOperationRecord,
} from './data-access-managed-policy.repository.js'
import {
  classifyManagedPolicyState,
  createPermissionSnapshot,
  isPolicyOperationRecoveryRequired,
} from './data-access-managed-policy.js'

interface BuildProjectDataAccessOverviewInput {
  projectId: string
  schemaName: string
  runtimeMode: ProjectDataAccessMode
  roles: DataAccessRoleNames
  inventory: DataAccessInventoryTable[]
  tableMetadata: HasuraTableMetadata[]
  managedPolicies?: ManagedPolicyRecord[]
  activeOperation?: PolicyOperationRecord | null
}

export function buildProjectDataAccessOverview(
  input: BuildProjectDataAccessOverviewInput
): ProjectDataAccessOverview {
  const metadataByTable = new Map(
    input.tableMetadata
      .filter((item) => item.table.schema === input.schemaName)
      .map((item) => [item.table.name, item])
  )
  const baselineByTable = new Map(
    (input.managedPolicies ?? []).map((item) => [item.tableName, item])
  )
  const builtTables = [...input.inventory]
    .sort((left, right) => left.tableName.localeCompare(right.tableName))
    .map((item) => buildTableOverview(
      item,
      metadataByTable.get(item.tableName),
      input.roles,
      baselineByTable.get(item.tableName) ?? null,
      input.activeOperation?.tableName === item.tableName ? input.activeOperation : null
    ))
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
      pendingConfigurationTables: builtTables.filter((item) => !item.hasSupportedPermission).length,
      actionRequiredTables: tables.filter((item) => [
        'refresh_required', 'adoption_required', 'custom', 'recovery_required',
      ].includes(item.managedState)).length,
    },
    tables,
  }
}

function buildTableOverview(
  inventory: DataAccessInventoryTable,
  metadata: HasuraTableMetadata | undefined,
  roles: DataAccessRoleNames,
  baseline: ManagedPolicyRecord | null,
  operation: PolicyOperationRecord | null
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
  const sourceCapabilities = baseline?.capabilitiesSnapshot
    ?? getInventoryColumnCapabilities(inventory)
  const sourceInspected = baseline
    ? inspectTableDataAccessMetadata(metadata ?? null, roles, sourceCapabilities)
    : inspected
  const hasAuthenticatedRead = sourceInspected.policy.authenticated.select !== 'none'
  const hasAuthenticatedWrite = ['insert', 'update', 'delete'].some(
    (operation) => sourceInspected.policy.authenticated[
      operation as 'insert' | 'update' | 'delete'
    ] !== 'none'
  )
  const hasAnonymousRead = sourceInspected.policy.anonymous.select
  const legacyAccess = {
    authenticated: inspected.legacyRoles.includes('user'),
    anonymous: inspected.legacyRoles.includes('anonymous'),
  }
  const permissions = sourceInspected.containsWildcard
    ? []
    : sourceInspected.authenticatedState === 'custom'
      || sourceInspected.anonymousState === 'custom'
      ? []
      : createPermissionSnapshot(materializeInspectedTableDataAccess(
          sourceInspected, roles, sourceCapabilities
        ))
  const managedState = classifyManagedPolicyState({
    inspectedState: sourceInspected.authenticatedState === 'custom'
      || sourceInspected.anonymousState === 'custom' ? 'custom' : 'managed',
    hasScopedPermissions: sourceInspected.permissions.length > 0,
    containsWildcard: sourceInspected.containsWildcard,
    currentPermissions: permissions,
    currentCapabilities: getInventoryColumnCapabilities(inventory),
    baseline,
    recoveryRequired: isPolicyOperationRecoveryRequired(operation),
  })
  const reviewRequired = !metadata
    || managedState !== 'managed'
    || legacyAccess.authenticated
    || legacyAccess.anonymous

  return {
    table: {
      tableName: inventory.tableName,
      managedState,
      dataInterface: metadata ? 'connected' : 'not_connected',
      authenticatedAccess: classifyAuthenticatedAccess(
        sourceInspected.authenticatedState,
        hasAuthenticatedRead,
        hasAuthenticatedWrite
      ),
      anonymousAccess: classifyAnonymousAccess(
        sourceInspected.anonymousState,
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
