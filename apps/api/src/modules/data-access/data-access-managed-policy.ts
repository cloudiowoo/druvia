import { createHash } from 'node:crypto'
import type {
  DataAccessColumnCapabilities,
  DataAccessColumnDrift,
  DataAccessColumnGrants,
  DataAccessPolicyOperationStatus,
  ManagedDataAccessState,
  MaterializedDataPermission,
  TableDataAccessInput,
} from './data-access.types.js'

export const POLICY_OPERATION_DRAIN_MS = 5_000
export const POLICY_OPERATION_ORPHAN_MS = 35_000

export interface ManagedPolicyBaselineShape {
  permissionsSnapshot: MaterializedDataPermission[]
  capabilitiesSnapshot: DataAccessColumnCapabilities
}

export function createPermissionSnapshot(
  permissions: MaterializedDataPermission[]
): MaterializedDataPermission[] {
  return permissions
    .map((item) => ({
      role: item.role,
      operation: item.operation,
      permission: normalizePermission(item.permission),
    }))
    .sort((left, right) => (
      left.role.localeCompare(right.role) || left.operation.localeCompare(right.operation)
    ))
}

export function permissionSnapshotDigest(snapshot: MaterializedDataPermission[]): string {
  return stableDigest(createPermissionSnapshot(snapshot))
}

export function isRecoverablePermissionSnapshot(
  current: MaterializedDataPermission[],
  source: MaterializedDataPermission[],
  target: MaterializedDataPermission[]
): boolean {
  const currentDigest = permissionSnapshotDigest(current)
  const sourceSnapshot = createPermissionSnapshot(source)
  const targetSnapshot = createPermissionSnapshot(target)
  const state = new Map(sourceSnapshot.map((item) => [permissionKey(item), item]))
  const allowed = new Set<string>([permissionSnapshotDigest([...state.values()])])

  // Hasura v2.48 fallback executes drops first and creates second. Only exact
  // command-prefix states can be attributed to the interrupted operation.
  for (const item of sourceSnapshot) {
    state.delete(permissionKey(item))
    allowed.add(permissionSnapshotDigest([...state.values()]))
  }
  for (const item of targetSnapshot) {
    state.set(permissionKey(item), item)
    allowed.add(permissionSnapshotDigest([...state.values()]))
  }
  return allowed.has(currentDigest)
}

function permissionKey(permission: MaterializedDataPermission): string {
  return `${permission.role}\u0000${permission.operation}`
}

export function stableDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex')
}

export function classifyManagedPolicyState(input: {
  inspectedState: 'managed' | 'custom'
  hasScopedPermissions: boolean
  containsWildcard: boolean
  currentPermissions: MaterializedDataPermission[]
  currentCapabilities: DataAccessColumnCapabilities
  baseline: ManagedPolicyBaselineShape | null
  recoveryRequired: boolean
}): ManagedDataAccessState {
  if (input.recoveryRequired) return 'recovery_required'
  if (input.inspectedState === 'custom' || input.containsWildcard) return 'custom'
  if (!input.baseline) return input.hasScopedPermissions ? 'adoption_required' : 'managed'
  if (
    permissionSnapshotDigest(input.currentPermissions)
    !== permissionSnapshotDigest(input.baseline.permissionsSnapshot)
  ) return 'custom'
  return capabilitiesEqual(input.currentCapabilities, input.baseline.capabilitiesSnapshot)
    ? 'managed'
    : 'refresh_required'
}

export function isPolicyOperationRecoveryRequired(
  operation: {
    status: DataAccessPolicyOperationStatus
    writeDeadlineAt: Date | null
    startedAt?: Date | null
    updatedAt?: Date | null
  } | null,
  now = new Date()
): boolean {
  if (!operation) return false
  if (operation.status === 'recovery_required') return true
  if (!['applying', 'recovering'].includes(operation.status)) return false
  const safeAt = policyOperationRecoverySafeAt(operation)
  return safeAt !== null && now.getTime() >= safeAt
}

export function policyOperationRecoverySafeAt(operation: {
  writeDeadlineAt: Date | null
  startedAt?: Date | null
  updatedAt?: Date | null
}): number | null {
  if (operation.writeDeadlineAt) {
    return operation.writeDeadlineAt.getTime() + POLICY_OPERATION_DRAIN_MS
  }
  const orphanedAt = operation.startedAt ?? operation.updatedAt
  return orphanedAt ? orphanedAt.getTime() + POLICY_OPERATION_ORPHAN_MS : null
}

export function normalizeColumnGrantsForPolicy(
  policy: TableDataAccessInput,
  grants: DataAccessColumnGrants
): DataAccessColumnGrants {
  const ownerColumn = policy.authenticated.ownerColumn
  const normalizeWrite = (operation: 'insert' | 'update') => {
    if (policy.authenticated[operation] === 'none') return []
    return policy.authenticated[operation] === 'owner'
      ? grants.authenticated[operation].filter((column) => column !== ownerColumn)
      : [...grants.authenticated[operation]]
  }
  return {
    authenticated: {
      select: policy.authenticated.select === 'none' ? [] : [...grants.authenticated.select],
      insert: normalizeWrite('insert'),
      update: normalizeWrite('update'),
    },
    anonymous: {
      select: policy.anonymous.select ? [...grants.anonymous.select] : [],
    },
  }
}

export function validateReconcilePolicyTransition(
  baseline: TableDataAccessInput,
  target: TableDataAccessInput
): void {
  for (const operation of ['select', 'insert', 'update', 'delete'] as const) {
    const nextMode = target.authenticated[operation]
    if (nextMode !== 'none' && nextMode !== baseline.authenticated[operation]) {
      throw new Error(`Reconciliation cannot broaden ${operation} access`)
    }
  }
  if (target.anonymous.select && !baseline.anonymous.select) {
    throw new Error('Reconciliation cannot broaden anonymous access')
  }
  const targetUsesOwner = (['select', 'insert', 'update', 'delete'] as const).some(
    (operation) => target.authenticated[operation] === 'owner'
  )
  if (targetUsesOwner
    && target.authenticated.ownerColumn !== baseline.authenticated.ownerColumn) {
    throw new Error('Reconciliation cannot replace the owner column')
  }
  if (!targetUsesOwner && target.authenticated.ownerColumn !== null) {
    throw new Error('Reconciliation must clear an unused owner column')
  }
}

export function buildColumnCapabilityDrift(
  baseline: DataAccessColumnCapabilities,
  current: DataAccessColumnCapabilities
): DataAccessColumnDrift {
  const addedReadable = difference(current.readableColumns, baseline.readableColumns)
  const addedInsertable = difference(current.insertableColumns, baseline.insertableColumns)
  const addedUpdateable = difference(current.updateableColumns, baseline.updateableColumns)
  const removedOrRestricted = uniqueSorted([
    ...difference(baseline.readableColumns, current.readableColumns),
    ...difference(baseline.insertableColumns, current.insertableColumns),
    ...difference(baseline.updateableColumns, current.updateableColumns),
  ])
  return { addedReadable, addedInsertable, addedUpdateable, removedOrRestricted }
}

export function materializeReconcileGrants(
  baseline: DataAccessColumnGrants,
  current: DataAccessColumnCapabilities
): DataAccessColumnGrants {
  return {
    authenticated: {
      select: intersection(baseline.authenticated.select, current.readableColumns),
      insert: intersection(baseline.authenticated.insert, current.insertableColumns),
      update: intersection(baseline.authenticated.update, current.updateableColumns),
    },
    anonymous: {
      select: intersection(baseline.anonymous.select, current.readableColumns),
    },
  }
}

export function capabilitiesEqual(
  left: DataAccessColumnCapabilities,
  right: DataAccessColumnCapabilities
): boolean {
  return stableDigest(left) === stableDigest(right)
}

function normalizePermission(permission: Record<string, unknown>): Record<string, unknown> {
  if (permission.columns === '*') {
    throw new Error('Hasura wildcard columns cannot be managed')
  }
  return sortJson(permission) as Record<string, unknown>
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return [...value].sort()
    return value.map(sortJson)
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)])
  )
}

function difference(left: string[], right: string[]): string[] {
  const values = new Set(right)
  return uniqueSorted(left.filter((item) => !values.has(item)))
}

function intersection(left: string[], right: string[]): string[] {
  const values = new Set(right)
  return uniqueSorted(left.filter((item) => values.has(item)))
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}
