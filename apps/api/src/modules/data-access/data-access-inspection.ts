import {
  createClosedTableDataAccessPolicy,
  materializeTableDataAccessPolicy,
} from './data-access-policy.js'
import type {
  AuthenticatedAccessMode,
  AuthorizationProjectionSelectConstraint,
  DataAccessColumnCapabilities,
  DataAccessOperation,
  DataAccessRoleNames,
  TableDataAccessInput,
  DataAccessColumnGrants,
  MaterializedDataPermission,
} from './data-access.types.js'

const OPERATIONS: DataAccessOperation[] = ['select', 'insert', 'update', 'delete']
const USER_ID_SESSION_VARIABLE = 'X-Hasura-User-Id'

export interface HasuraPermissionEntry {
  role: string
  permission: Record<string, unknown>
}

export interface HasuraTableMetadata {
  table: { schema: string; name: string }
  configuration?: Record<string, unknown>
  select_permissions?: HasuraPermissionEntry[]
  insert_permissions?: HasuraPermissionEntry[]
  update_permissions?: HasuraPermissionEntry[]
  delete_permissions?: HasuraPermissionEntry[]
}

export interface InspectedTableDataAccess {
  authenticatedState: 'managed' | 'custom'
  anonymousState: 'managed' | 'custom'
  policy: TableDataAccessInput
  legacyRoles: string[]
  existingManaged: Array<{ operation: DataAccessOperation; role: string }>
  permissions: MaterializedDataPermission[]
  columnGrants: DataAccessColumnGrants
  containsWildcard: boolean
}

export function materializeInspectedTableDataAccess(
  inspected: InspectedTableDataAccess,
  roles: DataAccessRoleNames,
  capabilities: DataAccessColumnCapabilities
): MaterializedDataPermission[] {
  if (
    inspected.authenticatedState === 'custom'
    || inspected.anonymousState === 'custom'
    || inspected.containsWildcard
  ) {
    throw new Error('Custom data access metadata cannot be materialized as managed')
  }
  return materializeTableDataAccessPolicy(inspected.policy, {
    roles,
    capabilities,
    columnGrants: inspected.columnGrants,
  })
}

export function inspectTableDataAccessMetadata(
  tableMetadata: HasuraTableMetadata | null,
  roles: DataAccessRoleNames,
  capabilities: DataAccessColumnCapabilities
): InspectedTableDataAccess {
  const policy = createClosedTableDataAccessPolicy()
  if (!tableMetadata) {
    return {
      authenticatedState: 'managed',
      anonymousState: 'managed',
      policy,
      legacyRoles: [],
      existingManaged: [],
      permissions: [],
      columnGrants: emptyColumnGrants(),
      containsWildcard: false,
    }
  }

  const legacyRoles = new Set<string>()
  const existingManaged: Array<{ operation: DataAccessOperation; role: string }> = []
  let authenticatedCustom = false
  let anonymousCustom = false
  let ownerColumn: string | null = null
  let containsWildcard = false
  const permissions: MaterializedDataPermission[] = []
  const columnGrants = emptyColumnGrants()

  for (const operation of OPERATIONS) {
    const entries = getPermissionEntries(tableMetadata, operation)
    for (const entry of entries) {
      if (entry.role === 'user' || entry.role === 'anonymous') {
        legacyRoles.add(entry.role)
      }
    }

    const authenticatedEntries = entries.filter((entry) => entry.role === roles.authenticated)
    const anonymousEntries = entries.filter((entry) => entry.role === roles.anonymous)

    for (const entry of [...authenticatedEntries, ...anonymousEntries]) {
      existingManaged.push({ operation, role: entry.role })
      permissions.push({ operation, role: entry.role, permission: entry.permission })
      if (entry.permission.columns === '*') containsWildcard = true
    }

    if (authenticatedEntries.length > 1) {
      authenticatedCustom = true
    } else if (authenticatedEntries.length === 1) {
      const mode = parseAuthenticatedPermission(
        operation,
        authenticatedEntries[0].permission,
        capabilities
      )
      if (!mode) {
        authenticatedCustom = true
      } else {
        policy.authenticated[operation] = mode.mode
        if (mode.selectConstraint) {
          policy.policyVersion = 2
          policy.authenticated.selectConstraint = mode.selectConstraint
        }
        if (operation !== 'delete') {
          columnGrants.authenticated[operation] = mode.columns
        }
        if (mode.ownerColumn) {
          if (ownerColumn && ownerColumn !== mode.ownerColumn) authenticatedCustom = true
          ownerColumn = mode.ownerColumn
        }
      }
    }

    if (anonymousEntries.length > 1) {
      anonymousCustom = true
    } else if (anonymousEntries.length === 1) {
      const anonymous = anonymousEntries[0]
      if (
        operation !== 'select'
        || !isSupportedAnonymousSelect(anonymous.permission, capabilities.readableColumns)
      ) {
        anonymousCustom = true
      } else {
        policy.anonymous.select = true
        columnGrants.anonymous.select = anonymous.permission.columns as string[]
      }
    }
  }

  policy.authenticated.ownerColumn = ownerColumn
  return {
    authenticatedState: authenticatedCustom ? 'custom' : 'managed',
    anonymousState: anonymousCustom ? 'custom' : 'managed',
    policy,
    legacyRoles: [...legacyRoles].sort(),
    existingManaged,
    permissions,
    columnGrants,
    containsWildcard,
  }
}

function getPermissionEntries(
  table: HasuraTableMetadata,
  operation: DataAccessOperation
): HasuraPermissionEntry[] {
  return table[`${operation}_permissions`] ?? []
}

function parseAuthenticatedPermission(
  operation: DataAccessOperation,
  permission: Record<string, unknown>,
  capabilities: DataAccessColumnCapabilities
): {
  mode: Exclude<AuthenticatedAccessMode, 'none'>
  ownerColumn: string | null
  columns: string[]
  selectConstraint: AuthorizationProjectionSelectConstraint | null
} | null {
  const rule = operation === 'insert' ? permission.check : permission.filter
  const projection = operation === 'select' ? parseProjectionRule(rule) : null
  const ownerColumn = projection?.ownerColumn ?? parseOwnerRule(rule)
  const allRows = isEmptyObject(rule)
  if (!allRows && (!ownerColumn || !capabilities.readableColumns.includes(ownerColumn))) return null
  const mode = allRows ? 'all' : 'owner'
  let columns: string[] = []

  switch (operation) {
    case 'select':
      if (!hasOnlyKeys(permission, ['columns', 'filter', 'allow_aggregations'])) return null
      {
        const parsed = parseExplicitColumns(permission.columns, capabilities.readableColumns)
        if (!parsed) return null
        columns = parsed
      }
      if (!isAggregationsDisabled(permission.allow_aggregations)) return null
      break
    case 'insert':
      if (!hasOnlyKeys(permission, ['columns', 'check', 'set'])) return null
      {
        const parsed = parseExplicitColumns(permission.columns, capabilities.insertableColumns)
        if (!parsed) return null
        columns = parsed
      }
      if (mode === 'owner') {
        if (!capabilities.insertableColumns.includes(ownerColumn!)) return null
        if (columns.includes(ownerColumn!)) return null
        if (!deepEqual(permission.set, { [ownerColumn!]: USER_ID_SESSION_VARIABLE })) return null
      } else if (!isEmptyOrMissingObject(permission.set)) return null
      break
    case 'update':
      if (!hasOnlyKeys(permission, ['columns', 'filter', 'check', 'set'])) return null
      {
        const parsed = parseExplicitColumns(permission.columns, capabilities.updateableColumns)
        if (!parsed) return null
        columns = parsed
      }
      if (mode === 'owner' && columns.includes(ownerColumn!)) return null
      if (!isEmptyOrMissingObject(permission.check) && !deepEqual(permission.check, rule)) return null
      if (!isEmptyOrMissingObject(permission.set)) return null
      break
    case 'delete':
      if (!hasOnlyKeys(permission, ['filter'])) return null
      break
  }

  return {
    mode,
    ownerColumn: mode === 'owner' ? ownerColumn : null,
    columns,
    selectConstraint: projection?.constraint ?? null,
  }
}

function isSupportedAnonymousSelect(
  permission: Record<string, unknown>,
  columns: string[]
): boolean {
  return hasOnlyKeys(permission, ['columns', 'filter', 'allow_aggregations'])
    && parseExplicitColumns(permission.columns, columns) !== null
    && isEmptyObject(permission.filter)
    && isAggregationsDisabled(permission.allow_aggregations)
}

function parseOwnerRule(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length !== 1) return null
  const [column, condition] = entries[0]
  if (!deepEqual(condition, { _eq: USER_ID_SESSION_VARIABLE })) return null
  return column
}

function parseProjectionRule(value: unknown): {
  ownerColumn: string
  constraint: AuthorizationProjectionSelectConstraint
} | null {
  if (!isRecord(value) || !hasExactKeys(value, ['_and'])) return null
  const parts = value._and
  if (!Array.isArray(parts) || parts.length !== 2) return null
  const ownerColumn = parseOwnerRule(parts[0])
  if (!ownerColumn || !isRecord(parts[1])) return null
  const relationshipEntries = Object.entries(parts[1])
  if (relationshipEntries.length !== 1) return null
  const [relationship, projectionRule] = relationshipEntries[0]
  if (!relationship || !isRecord(projectionRule)) return null
  const entries = Object.entries(projectionRule)
  if (entries.length !== 2) return null
  const actor = entries.find(([, condition]) => (
    deepEqual(condition, { _eq: USER_ID_SESSION_VARIABLE })
  ))
  const allow = entries.find(([, condition]) => deepEqual(condition, { _eq: true }))
  if (!actor || !allow || actor[0] === allow[0]) return null
  return {
    ownerColumn,
    constraint: {
      type: 'authorization_projection',
      relationshipPath: [relationship],
      actorColumn: actor[0],
      allowColumn: allow[0],
    },
  }
}

function parseExplicitColumns(value: unknown, allowed: string[]): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null
  if (new Set(value).size !== value.length) return null
  return value.every((column) => allowed.includes(column)) ? [...value].sort() : null
}

function isEmptyObject(value: unknown): boolean {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 0
}

function isEmptyOrMissingObject(value: unknown): boolean {
  return value === undefined || value === null || isEmptyObject(value)
}

function isAggregationsDisabled(value: unknown): boolean {
  return value === undefined || value === false
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function emptyColumnGrants(): DataAccessColumnGrants {
  return {
    authenticated: { select: [], insert: [], update: [] },
    anonymous: { select: [] },
  }
}
