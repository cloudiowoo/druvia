import type { ProjectDataAccessMode } from '@druvia/shared'

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

export interface DataAccessColumnCapabilities {
  readableColumns: string[]
  insertableColumns: string[]
  updateableColumns: string[]
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

export type DataInterfaceStatus = 'connected' | 'not_connected'
export type AuthenticatedAccessStatus =
  | 'closed'
  | 'read_only'
  | 'write_only'
  | 'read_write'
  | 'custom'
export type AnonymousAccessStatus = 'closed' | 'read' | 'custom'
export type DataAccessRealtimeStatus = 'disabled' | 'access_required' | 'configured'

export interface ProjectTableDataAccessOverview {
  tableName: string
  dataInterface: DataInterfaceStatus
  authenticatedAccess: AuthenticatedAccessStatus
  anonymousAccess: AnonymousAccessStatus
  realtime: DataAccessRealtimeStatus
  legacyAccess: {
    authenticated: boolean
    anonymous: boolean
  }
  reviewRequired: boolean
}

export interface ProjectDataAccessOverview {
  projectId: string
  schemaName: string
  runtimeMode: ProjectDataAccessMode
  summary: {
    totalTables: number
    configuredTables: number
    anonymousConfiguredTables: number
    realtimeAccessRequiredTables: number
    legacyTables: number
    reviewRequiredTables: number
  }
  tables: ProjectTableDataAccessOverview[]
}
