export type AuthenticatedAccessMode = 'none' | 'all' | 'owner'
export type DataAccessOperation = 'select' | 'insert' | 'update' | 'delete'

export interface AuthenticatedTableAccess {
  select: AuthenticatedAccessMode
  insert: AuthenticatedAccessMode
  update: AuthenticatedAccessMode
  delete: AuthenticatedAccessMode
  ownerColumn: string | null
}

export interface TableDataAccessInput {
  authenticated: AuthenticatedTableAccess
  anonymous: {
    select: boolean
  }
}

export interface DataAccessRoleNames {
  authenticated: string
  anonymous: string
}

export interface MaterializedDataPermission {
  role: string
  operation: DataAccessOperation
  permission: Record<string, unknown>
}

export interface TableDataAccessState {
  projectId: string
  schemaName: string
  tableName: string
  columns: string[]
  policy: TableDataAccessInput
  managedState: 'managed' | 'custom'
  legacyRoles: string[]
}
