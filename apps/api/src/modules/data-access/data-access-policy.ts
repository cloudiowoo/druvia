import type {
  AuthenticatedAccessMode,
  DataAccessColumnCapabilities,
  DataAccessOperation,
  DataAccessRoleNames,
  MaterializedDataPermission,
  TableDataAccessInput,
  DataAccessColumnGrants,
} from './data-access.types.js'

const ACCESS_MODES = new Set<AuthenticatedAccessMode>(['none', 'all', 'owner'])
const OPERATIONS: DataAccessOperation[] = ['select', 'insert', 'update', 'delete']
const USER_ID_SESSION_VARIABLE = 'X-Hasura-User-Id'

export class DataAccessValidationError extends Error {}

export interface MaterializeTableDataAccessOptions {
  roles: DataAccessRoleNames
  capabilities: DataAccessColumnCapabilities
  columnGrants?: DataAccessColumnGrants
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
        ownerColumn,
        options.columnGrants?.authenticated[operation === 'delete' ? 'select' : operation]
      ),
    })
  }

  if (input.anonymous.select) {
    result.push({
      role: options.roles.anonymous,
      operation: 'select',
      permission: {
        columns: options.capabilities.readableColumns,
        ...(options.columnGrants
          ? { columns: validateGrantColumns(
              options.columnGrants.anonymous.select,
              options.capabilities.readableColumns,
              'anonymous select'
            ) }
          : {}),
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
  ownerColumn: string | null,
  grantedColumns?: string[]
): Record<string, unknown> {
  const rowRule = mode === 'all'
    ? {}
    : { [ownerColumn!]: { _eq: USER_ID_SESSION_VARIABLE } }
  const writableColumns = (columns: string[]) => mode === 'owner'
    ? columns.filter((column) => column !== ownerColumn)
    : columns
  const operationColumns = (allowed: string[]) => {
    const selected = grantedColumns === undefined
      ? allowed
      : validateGrantColumns(grantedColumns, allowed, operation)
    return operation === 'insert' || operation === 'update'
      ? writableColumns(selected)
      : selected
  }

  switch (operation) {
    case 'select':
      return {
        columns: operationColumns(capabilities.readableColumns),
        filter: rowRule,
        allow_aggregations: false,
      }
    case 'insert':
      return {
        columns: operationColumns(capabilities.insertableColumns),
        check: rowRule,
        ...(mode === 'owner'
          ? { set: { [ownerColumn!]: USER_ID_SESSION_VARIABLE } }
          : {}),
      }
    case 'update':
      return {
        columns: operationColumns(capabilities.updateableColumns),
        filter: rowRule,
        check: rowRule,
      }
    case 'delete':
      return { filter: rowRule }
  }
}

function validateGrantColumns(
  columns: string[],
  allowed: string[],
  operation: string
): string[] {
  if (new Set(columns).size !== columns.length || columns.some((column) => !allowed.includes(column))) {
    throw new DataAccessValidationError(`Invalid column grant for ${operation}`)
  }
  return [...columns].sort()
}
