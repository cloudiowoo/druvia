import * as projectService from '../project/project.service.js'
import * as tableService from '../table/table.service.js'
import { hasuraMetadataRequest } from '../realtime/realtime.service.js'
import { resolveDataScopeRole } from './data-scope-role.js'
import {
  createClosedTableDataAccessPolicy,
  materializeTableDataAccessPolicy,
  validateTableDataAccessInput,
} from './data-access-policy.js'
import type {
  AuthenticatedAccessMode,
  DataAccessOperation,
  DataAccessRoleNames,
  TableDataAccessInput,
  TableDataAccessState,
} from './data-access.types.js'

const OPERATIONS: DataAccessOperation[] = ['select', 'insert', 'update', 'delete']
const USER_ID_SESSION_VARIABLE = 'X-Hasura-User-Id'

interface HasuraPermissionEntry {
  role: string
  permission: Record<string, unknown>
}

interface HasuraTableMetadata {
  table: { schema: string; name: string }
  select_permissions?: HasuraPermissionEntry[]
  insert_permissions?: HasuraPermissionEntry[]
  update_permissions?: HasuraPermissionEntry[]
  delete_permissions?: HasuraPermissionEntry[]
}

interface HasuraMetadata {
  sources?: Array<{ name?: string; tables?: HasuraTableMetadata[] }>
}

interface DataAccessContext {
  projectId: string
  schemaName: string
  tableName: string
  columns: string[]
  roles: DataAccessRoleNames
  tableMetadata: HasuraTableMetadata | null
}

interface InspectedPolicy {
  policy: TableDataAccessInput
  managedState: 'managed' | 'custom'
  legacyRoles: string[]
  existingManaged: Array<{ operation: DataAccessOperation; role: string }>
}

export class DataAccessNotFoundError extends Error {}
export class DataAccessConflictError extends Error {}
export class DataAccessUpstreamError extends Error {}

export async function getTableDataAccess(
  projectId: string,
  tableName: string
): Promise<TableDataAccessState> {
  const context = await loadDataAccessContext(projectId, tableName)
  const inspected = inspectTablePolicy(context)
  return toState(context, inspected)
}

export async function updateTableDataAccess(
  projectId: string,
  tableName: string,
  input: TableDataAccessInput
): Promise<TableDataAccessState> {
  const context = await loadDataAccessContext(projectId, tableName)
  const inspected = inspectTablePolicy(context)
  if (inspected.managedState === 'custom') {
    throw new DataAccessConflictError(
      'Managed data access metadata contains custom rules and cannot be overwritten'
    )
  }

  validateTableDataAccessInput(input, context.columns)
  const tracked = await tableService.trackTableInHasura(context.schemaName, context.tableName)
  if (!tracked) {
    throw new DataAccessUpstreamError('Unable to connect table to data interface')
  }

  const desired = materializeTableDataAccessPolicy(input, {
    roles: context.roles,
    columns: context.columns,
  })
  const table = { schema: context.schemaName, name: context.tableName }
  const commands: Array<{ type: string; args: Record<string, unknown> }> = []

  for (const existing of inspected.existingManaged) {
    commands.push({
      type: `pg_drop_${existing.operation}_permission`,
      args: { source: 'default', table, role: existing.role },
    })
  }
  for (const item of desired) {
    commands.push({
      type: `pg_create_${item.operation}_permission`,
      args: {
        source: 'default',
        table,
        role: item.role,
        permission: item.permission,
      },
    })
  }

  if (commands.length > 0) {
    try {
      await hasuraMetadataRequest('bulk_atomic', commands as never)
    } catch (error) {
      throw new DataAccessUpstreamError(
        error instanceof Error ? error.message : 'Unable to update data access metadata'
      )
    }
  }

  return {
    projectId,
    schemaName: context.schemaName,
    tableName,
    columns: context.columns,
    policy: input,
    managedState: 'managed',
    legacyRoles: inspected.legacyRoles,
  }
}

async function loadDataAccessContext(
  projectId: string,
  tableName: string
): Promise<DataAccessContext> {
  const project = await projectService.getProjectById(projectId)
  if (!project?.schemaName) {
    throw new DataAccessNotFoundError('Project or project schema not found')
  }

  const table = await tableService.getTableMetadata(project.schemaName, tableName)
  if (!table) {
    throw new DataAccessNotFoundError('Table not found')
  }

  let metadata: HasuraMetadata
  try {
    metadata = await hasuraMetadataRequest<HasuraMetadata>('export_metadata', {})
  } catch (error) {
    throw new DataAccessUpstreamError(
      error instanceof Error ? error.message : 'Unable to read data access metadata'
    )
  }

  const source = metadata.sources?.find((item) => item.name === 'default')
    ?? metadata.sources?.[0]
  const tableMetadata = source?.tables?.find(
    (item) => item.table.schema === project.schemaName && item.table.name === tableName
  ) ?? null

  return {
    projectId,
    schemaName: project.schemaName,
    tableName,
    columns: table.columns.map((column) => column.name),
    roles: {
      authenticated: resolveDataScopeRole({ projectId, actor: 'authenticated' }),
      anonymous: resolveDataScopeRole({ projectId, actor: 'anonymous' }),
    },
    tableMetadata,
  }
}

function inspectTablePolicy(context: DataAccessContext): InspectedPolicy {
  const policy = createClosedTableDataAccessPolicy()
  if (!context.tableMetadata) {
    return { policy, managedState: 'managed', legacyRoles: [], existingManaged: [] }
  }

  const legacyRoles = new Set<string>()
  const existingManaged: Array<{ operation: DataAccessOperation; role: string }> = []
  let custom = false
  let ownerColumn: string | null = null

  for (const operation of OPERATIONS) {
    const entries = getPermissionEntries(context.tableMetadata, operation)
    for (const entry of entries) {
      if (entry.role === 'user' || entry.role === 'anonymous') {
        legacyRoles.add(entry.role)
      }
    }

    const authenticatedEntries = entries.filter(
      (entry) => entry.role === context.roles.authenticated
    )
    const anonymousEntries = entries.filter(
      (entry) => entry.role === context.roles.anonymous
    )

    for (const entry of [...authenticatedEntries, ...anonymousEntries]) {
      existingManaged.push({ operation, role: entry.role })
    }

    if (authenticatedEntries.length > 1 || anonymousEntries.length > 1) {
      custom = true
      continue
    }

    const authenticated = authenticatedEntries[0]
    if (authenticated) {
      const mode = parseAuthenticatedPermission(
        operation,
        authenticated.permission,
        context.columns
      )
      if (!mode) {
        custom = true
      } else {
        policy.authenticated[operation] = mode.mode
        if (mode.ownerColumn) {
          if (ownerColumn && ownerColumn !== mode.ownerColumn) custom = true
          ownerColumn = mode.ownerColumn
        }
      }
    }

    const anonymous = anonymousEntries[0]
    if (anonymous) {
      if (
        operation !== 'select'
        || !isAllSelectPermission(anonymous.permission, context.columns)
      ) {
        custom = true
      } else {
        policy.anonymous.select = true
      }
    }
  }

  policy.authenticated.ownerColumn = ownerColumn
  return {
    policy,
    managedState: custom ? 'custom' : 'managed',
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

function toState(
  context: DataAccessContext,
  inspected: InspectedPolicy
): TableDataAccessState {
  return {
    projectId: context.projectId,
    schemaName: context.schemaName,
    tableName: context.tableName,
    columns: context.columns,
    policy: inspected.policy,
    managedState: inspected.managedState,
    legacyRoles: inspected.legacyRoles,
  }
}
