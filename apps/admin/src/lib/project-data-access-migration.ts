export type DataAccessMigrationOperation = 'select' | 'insert' | 'update' | 'delete'
export type DataAccessMigrationStatus =
  | 'preview_ready' | 'applying' | 'applied' | 'rolling_back'
  | 'rolled_back' | 'recovered' | 'failed' | 'superseded'
export type DataAccessMigrationPhase =
  | 'preview' | 'snapshot_check' | 'prepare_scoped_permissions'
  | 'verify_scoped_metadata' | 'verify_scoped_http' | 'verify_scoped_realtime'
  | 'remove_legacy_permissions' | 'activate_explicit_mode' | 'verify_active_runtime'
  | 'rollback_snapshot_check' | 'restore_permissions' | 'restore_runtime_mode'
  | 'verify_recovery_target' | 'completed'

export interface DataAccessMigrationBlocker {
  tableName: string | null
  actor: 'authenticated' | 'anonymous' | 'system'
  operation: DataAccessMigrationOperation | null
  reason: 'custom_legacy_rule' | 'custom_scoped_rule' | 'duplicate_rule'
    | 'unsupported_tracked_object' | 'unsupported_source_customization' | 'cross_project_role_binding'
}

export interface DataAccessMigrationDestructiveChange {
  tableName: string
  actor: 'authenticated' | 'anonymous'
  operation: DataAccessMigrationOperation
  reason: 'anonymous_write_removed' | 'authenticated_aggregations_removed'
}

export interface ProjectDataAccessMigrationReport {
  migrationId: string
  projectId: string
  status: DataAccessMigrationStatus
  phase: DataAccessMigrationPhase
  sourceDigest: string
  rollbackPreviewDigest: string | null
  requiredRecoveryDigest: string | null
  recoveryTarget: 'pre_migration' | 'current_explicit' | null
  appliedAt: string | null
  canApply: boolean
  canRollback: boolean
  summary: {
    totalTables: number
    migratedTables: number
    preservedScopedTables: number
    inferredOperationCount: number
    blockerCount: number
    destructiveChangeCount: number
  }
  blockers: DataAccessMigrationBlocker[]
  destructiveChanges: DataAccessMigrationDestructiveChange[]
  tables: Array<{
    tableName: string
    targetSource: 'existing_scoped' | 'legacy_default' | 'mixed' | 'closed'
    inferredOperations: Array<{ actor: 'authenticated' | 'anonymous'; operation: DataAccessMigrationOperation }>
    authenticated: 'closed' | 'read_only' | 'write_only' | 'read_write'
    anonymousRead: boolean
    removesAnonymousWrite: boolean
    removesAuthenticatedAggregations: boolean
    blocked: boolean
  }>
  error: { code: string; message: string } | null
}

const PHASE_STEPS = [
  { phases: ['snapshot_check', 'rollback_snapshot_check'], label: '校验快照' },
  { phases: ['prepare_scoped_permissions', 'restore_permissions'], label: '准备权限' },
  { phases: ['verify_scoped_metadata', 'verify_scoped_http', 'verify_scoped_realtime'], label: '验证访问' },
  { phases: ['remove_legacy_permissions'], label: '移除旧规则' },
  { phases: ['activate_explicit_mode', 'restore_runtime_mode'], label: '激活' },
  { phases: ['verify_active_runtime', 'verify_recovery_target', 'completed'], label: '最终验证' },
] as const

export function getMigrationPhaseProgress(phase: DataAccessMigrationPhase) {
  const index = PHASE_STEPS.findIndex((step) => (step.phases as readonly string[]).includes(phase))
  return { index: Math.max(0, index), label: PHASE_STEPS[Math.max(0, index)].label, steps: PHASE_STEPS }
}

export function getMigrationStatusLabel(status: DataAccessMigrationStatus): string {
  return {
    preview_ready: '预检已生成', applying: '正在升级', applied: '已启用项目级访问',
    rolling_back: '正在恢复兼容模式', rolled_back: '已恢复兼容模式', recovered: '已恢复迁移前状态',
    failed: '需要处理', superseded: '预检已更新',
  }[status]
}

export function requiresAliasConfirmation(summary: {
  inferredOperationCount: number
  destructiveChangeCount: number
}): boolean {
  return summary.inferredOperationCount > 0 || summary.destructiveChangeCount > 0
}

export function summarizeMigrationTableAccess(
  authenticated: ProjectDataAccessMigrationReport['tables'][number]['authenticated'],
  anonymousRead: boolean
): string {
  if (authenticated === 'closed' && !anonymousRead) return '升级后保持关闭'
  const authenticatedLabel = {
    closed: '认证用户关闭', read_only: '认证用户只读', write_only: '认证用户只写', read_write: '认证用户可读写',
  }[authenticated]
  return `${authenticatedLabel}${anonymousRead ? '，匿名可读' : ''}`
}

export function getBlockerLabel(reason: DataAccessMigrationBlocker['reason']): string {
  return {
    custom_legacy_rule: '旧访问规则需要人工确认', custom_scoped_rule: '现有访问规则超出简化配置范围',
    duplicate_rule: '存在重复访问规则', unsupported_tracked_object: '存在暂不支持自动迁移的数据对象',
    unsupported_source_customization: '项目使用了暂不支持的接口命名方式',
    cross_project_role_binding: '项目访问身份被用于其他数据范围',
  }[reason]
}
