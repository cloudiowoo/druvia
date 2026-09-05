import type {
  AuthenticatedAccessMode,
  DataAccessColumnCapabilities,
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
  capabilities: DataAccessColumnCapabilities
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
  capabilities: DataAccessColumnCapabilities
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
  if (!capabilities.readableColumns.includes(input.authenticated.ownerColumn)) {
    throw new DataAccessValidationError('Owner column does not exist in the table')
  }
  if (
    input.authenticated.insert === 'owner'
    && !capabilities.insertableColumns.includes(input.authenticated.ownerColumn)
  ) {
    throw new DataAccessValidationError('Owner column is not insertable')
  }
}

export function materializeTableDataAccessPolicy(
  input: TableDataAccessInput,
  options: MaterializeTableDataAccessOptions
): MaterializedDataPermission[] {
  validateTableDataAccessInput(input, options.capabilities)

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
        options.capabilities,
        ownerColumn
      ),
    })
  }

  if (input.anonymous.select) {
    result.push({
      role: options.roles.anonymous,
      operation: 'select',
      permission: {
        columns: options.capabilities.readableColumns,
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
  capabilities: DataAccessColumnCapabilities,
  ownerColumn: string | null
): Record<string, unknown> {
  const rowRule = mode === 'all'
    ? {}
    : { [ownerColumn!]: { _eq: USER_ID_SESSION_VARIABLE } }
  const writableColumns = (columns: string[]) => mode === 'owner'
    ? columns.filter((column) => column !== ownerColumn)
    : columns

  switch (operation) {
    case 'select':
      return {
        columns: capabilities.readableColumns,
        filter: rowRule,
        allow_aggregations: false,
      }
    case 'insert':
      return {
        columns: writableColumns(capabilities.insertableColumns),
        check: rowRule,
        ...(mode === 'owner'
          ? { set: { [ownerColumn!]: USER_ID_SESSION_VARIABLE } }
          : {}),
      }
    case 'update':
      return {
        columns: writableColumns(capabilities.updateableColumns),
        filter: rowRule,
        check: rowRule,
      }
    case 'delete':
      return { filter: rowRule }
  }
}
