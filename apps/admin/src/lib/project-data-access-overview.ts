export type DataInterfaceStatus = 'connected' | 'not_connected'
export type AuthenticatedAccessStatus =
  | 'closed'
  | 'read_only'
  | 'write_only'
  | 'read_write'
  | 'custom'
export type AnonymousAccessStatus = 'closed' | 'read' | 'custom'
export type DataAccessRealtimeStatus = 'disabled' | 'access_required' | 'configured'
export type ProjectDataAccessFilter =
  | 'all'
  | 'unconfigured'
  | 'anonymous'
  | 'realtime'
  | 'review'

export interface ProjectTableDataAccessOverview {
  tableName: string
  managedState: 'managed' | 'refresh_required' | 'adoption_required' | 'custom' | 'recovery_required'
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
  runtimeMode: 'compatibility' | 'explicit'
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

export const PROJECT_DATA_ACCESS_FILTERS: Array<{
  value: ProjectDataAccessFilter
  label: string
}> = [
  { value: 'all', label: '全部' },
  { value: 'unconfigured', label: '待配置' },
  { value: 'anonymous', label: '匿名已配置' },
  { value: 'realtime', label: 'Realtime 待授权' },
  { value: 'review', label: '需检查' },
]

export function getDataInterfaceLabel(status: DataInterfaceStatus): string {
  return status === 'connected' ? '已连接' : '未连接'
}

export function getManagedDataAccessLabel(
  state: ProjectTableDataAccessOverview['managedState']
): string {
  return {
    managed: '已配置',
    refresh_required: '结构已变化',
    adoption_required: '需要接管',
    custom: '自定义策略',
    recovery_required: '需要恢复',
  }[state]
}

export function getAuthenticatedAccessLabel(status: AuthenticatedAccessStatus): string {
  return {
    closed: '关闭',
    read_only: '只读',
    write_only: '只写',
    read_write: '读写',
    custom: '需检查',
  }[status]
}

export function getAnonymousAccessLabel(status: AnonymousAccessStatus): string {
  return {
    closed: '关闭',
    read: '允许读取',
    custom: '需检查',
  }[status]
}

export function getRealtimeAccessLabel(status: DataAccessRealtimeStatus): string {
  return {
    disabled: '未启用',
    access_required: '待授权',
    configured: '已配置',
  }[status]
}

export function getLegacyAccessLabel(
  legacyAccess: ProjectTableDataAccessOverview['legacyAccess']
): string {
  if (legacyAccess.authenticated && legacyAccess.anonymous) return '认证用户、匿名访问'
  if (legacyAccess.authenticated) return '认证用户'
  if (legacyAccess.anonymous) return '匿名访问'
  return '无'
}

export function filterProjectDataAccessTables(
  tables: ProjectTableDataAccessOverview[],
  filter: ProjectDataAccessFilter
): ProjectTableDataAccessOverview[] {
  switch (filter) {
    case 'all':
      return tables
    case 'unconfigured':
      return tables.filter((table) => table.dataInterface === 'connected'
        && table.authenticatedAccess === 'closed'
        && table.anonymousAccess === 'closed'
        && !table.reviewRequired)
    case 'anonymous':
      return tables.filter((table) => table.anonymousAccess === 'read')
    case 'realtime':
      return tables.filter((table) => table.realtime === 'access_required')
    case 'review':
      return tables.filter((table) => table.reviewRequired)
  }
}

export function buildTableDataAccessLink(
  tenantId: string,
  projectId: string,
  tableName: string
): string {
  return `/t/${encodeURIComponent(tenantId)}/p/${encodeURIComponent(projectId)}`
    + `/tables/${encodeURIComponent(tableName)}?tab=access&scope=default`
}
