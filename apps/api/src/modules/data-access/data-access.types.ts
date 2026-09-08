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

export interface TableDataAccessUpdateInput extends TableDataAccessInput {
  operationId: string
  expectedBaselineRevision?: number
  columnGrants?: DataAccessColumnGrants
}

export interface DataAccessPolicyPreview {
  operation: DataAccessPolicyOperationState
  projectId: string
  schemaName: string
  tableName: string
  baselineRevision: number | null
  policy: TableDataAccessInput
  columnGrants: DataAccessColumnGrants
  capabilities: {
    readable: string[]
    insertable: string[]
    updateable: string[]
  }
  drift: DataAccessColumnDrift | null
}

export interface DataAccessColumnGrants {
  authenticated: {
    select: string[]
    insert: string[]
    update: string[]
  }
  anonymous: {
    select: string[]
  }
}

export type ManagedDataAccessState =
  | 'managed'
  | 'refresh_required'
  | 'adoption_required'
  | 'custom'
  | 'recovery_required'

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
  managedState: ManagedDataAccessState
  legacyRoles: string[]
  baselineRevision: number | null
  capabilities: {
    readable: string[]
    insertable: string[]
    updateable: string[]
  }
  effective: DataAccessColumnGrants
  drift: DataAccessColumnDrift | null
  activeOperation: DataAccessPolicyOperationState | null
}

export interface DataAccessColumnDrift {
  addedReadable: string[]
  addedInsertable: string[]
  addedUpdateable: string[]
  removedOrRestricted: string[]
}

export type DataAccessPolicyOperationKind = 'adoption' | 'policy_update' | 'reconcile'
export type DataAccessPolicyOperationStatus =
  | 'preview_ready'
  | 'applying'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'recovery_required'
  | 'superseded'

export interface DataAccessPolicyOperationState {
  operationId: string
  tableName: string
  kind: DataAccessPolicyOperationKind
  status: DataAccessPolicyOperationStatus
  phase: string
  sourceDigest: string
  targetDigest: string | null
  writeDeadlineAt: string | null
  startedAt: string | null
  error: { code: string; message: string } | null
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
  managedState: ManagedDataAccessState
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
    pendingConfigurationTables: number
    actionRequiredTables: number
  }
  tables: ProjectTableDataAccessOverview[]
}
