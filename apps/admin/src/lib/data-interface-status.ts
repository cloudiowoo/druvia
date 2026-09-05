export interface DataInterfaceStatusInput {
  tracked: boolean
  runtimeAvailability?: 'available' | 'environment_identity_required'
  hasAuthenticatedRead?: boolean
  hasAnonymousRead?: boolean
}

export type RealtimeAccessStatus = 'disabled' | 'access_required' | 'ready' | 'unknown'

export interface DataInterfaceSyncResult {
  tracked: string[]
  failed: string[]
  relationships: number
  untracked: number
}

export interface DataInterfaceSyncFeedback {
  title: string
  description?: string
  variant?: 'destructive'
}

export function getDataInterfaceLabel(status: DataInterfaceStatusInput): string {
  if (!status.tracked) return '未接入'
  if (status.runtimeAvailability === 'environment_identity_required') return '环境访问暂不可用'
  if (status.hasAuthenticatedRead) return '可用'
  if (status.hasAnonymousRead) return '匿名可用'
  return '待配置访问'
}

export function getRealtimeLabel(status: RealtimeAccessStatus): string {
  const labels: Record<RealtimeAccessStatus, string> = {
    disabled: '未启用',
    access_required: '待读取权限',
    ready: '可用',
    unknown: '状态未知',
  }
  return labels[status]
}

export function getRealtimeToggleMessage(
  enabled: boolean,
  status: RealtimeAccessStatus
): string {
  if (!enabled) return '实时更新已关闭'
  if (status === 'access_required') return '已启用，请先配置读取权限'
  if (status === 'unknown') return '已启用，权限状态暂不可用'
  return '实时更新已启用'
}

export function getDataInterfaceSyncFeedback(
  result: DataInterfaceSyncResult
): DataInterfaceSyncFeedback {
  if (result.failed.length > 0) {
    return {
      title: `${result.failed.length} 张表同步失败`,
      description: result.failed.join('、'),
      variant: 'destructive',
    }
  }

  const parts = [`已同步 ${result.tracked.length} 张表`]
  if (result.relationships > 0) parts.push(`${result.relationships} 个关系`)
  if (result.untracked > 0) parts.push(`清理 ${result.untracked} 个残留`)
  return { title: parts.join('，') }
}
