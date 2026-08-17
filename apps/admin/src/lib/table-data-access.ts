export type TableAccessMode = 'none' | 'all' | 'owner'
export type AuthenticatedDataOperation = 'select' | 'insert' | 'update' | 'delete'

export interface TableDataAccessPolicy {
  authenticated: {
    select: TableAccessMode
    insert: TableAccessMode
    update: TableAccessMode
    delete: TableAccessMode
    ownerColumn: string | null
  }
  anonymous: {
    select: boolean
  }
}

export interface TableDataAccessState {
  projectId: string
  schemaName: string
  tableName: string
  columns: string[]
  policy: TableDataAccessPolicy
  managedState: 'managed' | 'custom'
  legacyRoles: string[]
}

const OPERATIONS: AuthenticatedDataOperation[] = ['select', 'insert', 'update', 'delete']

export function getAccessModeLabel(mode: TableAccessMode): string {
  const labels: Record<TableAccessMode, string> = {
    none: '关闭',
    all: '全部记录',
    owner: '仅自己的记录',
  }
  return labels[mode]
}

export function requiresOwnerColumn(policy: TableDataAccessPolicy): boolean {
  return OPERATIONS.some((operation) => policy.authenticated[operation] === 'owner')
}

export function hasUnrestrictedWriteAccess(policy: TableDataAccessPolicy): boolean {
  return (['insert', 'update', 'delete'] as AuthenticatedDataOperation[])
    .some((operation) => policy.authenticated[operation] === 'all')
}

export function getTableDataAccessValidationError(
  policy: TableDataAccessPolicy,
  columns: string[]
): string | null {
  if (!requiresOwnerColumn(policy)) return null
  if (!policy.authenticated.ownerColumn) return '请选择所有者字段'
  if (!columns.includes(policy.authenticated.ownerColumn)) return '所有者字段不存在'
  return null
}

export function cloneTableDataAccessPolicy(
  policy: TableDataAccessPolicy
): TableDataAccessPolicy {
  return {
    authenticated: { ...policy.authenticated },
    anonymous: { ...policy.anonymous },
  }
}

export function isDefaultTableDataScope(
  projectSchema: string | null | undefined,
  selectedSchema: string | null | undefined
): boolean {
  return !!projectSchema && selectedSchema === projectSchema
}
