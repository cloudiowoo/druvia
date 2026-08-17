import { createClosedTableDataAccessPolicy } from './data-access-policy.js'
import type {
  AuthenticatedAccessMode,
  DataAccessOperation,
  DataAccessRoleNames,
  TableDataAccessInput,
} from './data-access.types.js'

const OPERATIONS: DataAccessOperation[] = ['select', 'insert', 'update', 'delete']
const USER_ID_SESSION_VARIABLE = 'X-Hasura-User-Id'

export interface HasuraPermissionEntry {
  role: string
  permission: Record<string, unknown>
}

export interface HasuraTableMetadata {
  table: { schema: string; name: string }
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
}

export function inspectTableDataAccessMetadata(
  tableMetadata: HasuraTableMetadata | null,
  roles: DataAccessRoleNames,
  columns: string[]
): InspectedTableDataAccess {
  const policy = createClosedTableDataAccessPolicy()
  if (!tableMetadata) {
    return {
      authenticatedState: 'managed',
      anonymousState: 'managed',
      policy,
      legacyRoles: [],
      existingManaged: [],
    }
  }

  const legacyRoles = new Set<string>()
  const existingManaged: Array<{ operation: DataAccessOperation; role: string }> = []
  let authenticatedCustom = false
  let anonymousCustom = false
  let ownerColumn: string | null = null

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
    }

    if (authenticatedEntries.length > 1) {
      authenticatedCustom = true
    } else if (authenticatedEntries.length === 1) {
      const mode = parseAuthenticatedPermission(
        operation,
        authenticatedEntries[0].permission,
        columns
      )
      if (!mode) {
        authenticatedCustom = true
      } else {
        policy.authenticated[operation] = mode.mode
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
        || !isAllSelectPermission(anonymous.permission, columns)
      ) {
        anonymousCustom = true
      } else {
        policy.anonymous.select = true
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
  columns: string[]
): { mode: Exclude<AuthenticatedAccessMode, 'none'>; ownerColumn: string | null } | null {
  if (isAllPermission(operation, permission, columns)) {
    return { mode: 'all', ownerColumn: null }
  }

  const rule = operation === 'insert' ? permission.check : permission.filter
  const ownerColumn = parseOwnerRule(rule)
  if (!ownerColumn || !columns.includes(ownerColumn)) return null
  const writableColumns = columns.filter((column) => column !== ownerColumn)

  switch (operation) {
    case 'select':
      if (!hasOnlyKeys(permission, ['columns', 'filter', 'allow_aggregations'])) return null
      if (!columnsMatch(permission.columns, columns)) return null
      if (!isAggregationsDisabled(permission.allow_aggregations)) return null
      break
    case 'insert':
      if (!hasOnlyKeys(permission, ['columns', 'check', 'set'])) return null
      if (!columnsMatch(permission.columns, writableColumns)) return null
      if (!deepEqual(permission.set, { [ownerColumn]: USER_ID_SESSION_VARIABLE })) return null
      break
    case 'update':
      if (!hasOnlyKeys(permission, ['columns', 'filter', 'check', 'set'])) return null
      if (!columnsMatch(permission.columns, writableColumns)) return null
      if (!deepEqual(permission.check, rule)) return null
      if (!isEmptyOrMissingObject(permission.set)) return null
      break
    case 'delete':
      if (!hasOnlyKeys(permission, ['filter'])) return null
      break
  }

  return { mode: 'owner', ownerColumn }
}

function isAllPermission(
  operation: DataAccessOperation,
  permission: Record<string, unknown>,
  columns: string[]
): boolean {
  switch (operation) {
    case 'select':
      return isAllSelectPermission(permission, columns)
    case 'insert':
      return hasOnlyKeys(permission, ['columns', 'check', 'set'])
        && columnsMatch(permission.columns, columns)
        && isEmptyObject(permission.check)
        && isEmptyOrMissingObject(permission.set)
    case 'update':
      return hasOnlyKeys(permission, ['columns', 'filter', 'check', 'set'])
        && columnsMatch(permission.columns, columns)
        && isEmptyObject(permission.filter)
        && isEmptyOrMissingObject(permission.check)
        && isEmptyOrMissingObject(permission.set)
    case 'delete':
      return hasOnlyKeys(permission, ['filter']) && isEmptyObject(permission.filter)
  }
}

function isAllSelectPermission(
  permission: Record<string, unknown>,
  columns: string[]
): boolean {
  return hasOnlyKeys(permission, ['columns', 'filter', 'allow_aggregations'])
    && columnsMatch(permission.columns, columns)
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

function columnsMatch(value: unknown, expected: string[]): boolean {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return false
  return value.length === expected.length
    && expected.every((column) => value.includes(column))
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

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
