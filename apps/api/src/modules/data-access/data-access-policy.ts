import type {
  AuthenticatedAccessMode,
  DataAccessOperation,
  DataAccessRoleNames,
  MaterializedDataPermission,
  TableDataAccessInput,
} from './data-access.types.js'

const ACCESS_MODES = new Set<AuthenticatedAccessMode>(['none', 'all', 'owner'])
const OPERATIONS: DataAccessOperation[] = ['select', 'insert', 'update', 'delete']
const USER_ID_SESSION_VARIABLE = 'X-Hasura-User-Id'

export class DataAccessValidationError extends Error {}

export interface MaterializeTableDataAccessOptions {
  roles: DataAccessRoleNames
  columns: string[]
}

export function createClosedTableDataAccessPolicy(): TableDataAccessInput {
  return {
    authenticated: {
      select: 'none',
      insert: 'none',
      update: 'none',
      delete: 'none',
      ownerColumn: null,
    },
    anonymous: { select: false },
  }
}

export function validateTableDataAccessInput(
  input: TableDataAccessInput,
  columns: string[]
): void {
  for (const operation of OPERATIONS) {
    const mode = input.authenticated?.[operation]
    if (!ACCESS_MODES.has(mode)) {
      throw new DataAccessValidationError(`Unsupported access mode for ${operation}`)
    }
  }

  if (typeof input.anonymous?.select !== 'boolean') {
    throw new DataAccessValidationError('Anonymous select must be a boolean')
  }

  const usesOwnerMode = OPERATIONS.some(
    (operation) => input.authenticated[operation] === 'owner'
  )
  if (!usesOwnerMode) return

  if (!input.authenticated.ownerColumn) {
    throw new DataAccessValidationError('Owner column is required for owner access')
  }
  if (!columns.includes(input.authenticated.ownerColumn)) {
    throw new DataAccessValidationError('Owner column does not exist in the table')
  }
}

export function materializeTableDataAccessPolicy(
  input: TableDataAccessInput,
  options: MaterializeTableDataAccessOptions
): MaterializedDataPermission[] {
  validateTableDataAccessInput(input, options.columns)

  const result: MaterializedDataPermission[] = []
  const ownerColumn = input.authenticated.ownerColumn

  for (const operation of OPERATIONS) {
    const mode = input.authenticated[operation]
    if (mode === 'none') continue

    result.push({
      role: options.roles.authenticated,
      operation,
      permission: createAuthenticatedPermission(
        operation,
        mode,
        options.columns,
        ownerColumn
      ),
    })
  }

  if (input.anonymous.select) {
    result.push({
      role: options.roles.anonymous,
      operation: 'select',
      permission: {
        columns: options.columns,
        filter: {},
        allow_aggregations: false,
      },
    })
  }

  return result
}

function createAuthenticatedPermission(
  operation: DataAccessOperation,
  mode: Exclude<AuthenticatedAccessMode, 'none'>,
  columns: string[],
  ownerColumn: string | null
): Record<string, unknown> {
  const rowRule = mode === 'all'
    ? {}
    : { [ownerColumn!]: { _eq: USER_ID_SESSION_VARIABLE } }
  const writableColumns = mode === 'owner'
    ? columns.filter((column) => column !== ownerColumn)
    : columns

  switch (operation) {
    case 'select':
      return { columns, filter: rowRule, allow_aggregations: false }
    case 'insert':
      return {
        columns: writableColumns,
        check: rowRule,
        ...(mode === 'owner'
          ? { set: { [ownerColumn!]: USER_ID_SESSION_VARIABLE } }
          : {}),
      }
    case 'update':
      return { columns: writableColumns, filter: rowRule, check: rowRule }
    case 'delete':
      return { filter: rowRule }
  }
}
