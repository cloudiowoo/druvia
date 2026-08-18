'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  getBlockerLabel,
  getMigrationPhaseProgress,
  getMigrationStatusLabel,
  requiresAliasConfirmation,
  summarizeMigrationTableAccess,
  type ProjectDataAccessMigrationReport,
} from '@/lib/project-data-access-migration'

interface Props {
  tenantId: string
  projectId: string
  projectAlias: string
  runtimeMode: 'compatibility' | 'explicit'
  migration: ProjectDataAccessMigrationReport | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onChanged: (migration: ProjectDataAccessMigrationReport) => void
}

type DialogMode = 'preview' | 'recovery' | 'rollback' | 'operator' | null

export function ProjectDataAccessMigration({
  tenantId,
  projectId,
  projectAlias,
  runtimeMode,
  migration,
  loading,
  error,
  onRefresh,
  onChanged,
}: Props) {
  const { toast } = useToast()
  const [dialogMode, setDialogMode] = useState<DialogMode>(null)
  const [busy, setBusy] = useState(false)
  const [reviewConfirmed, setReviewConfirmed] = useState(false)
  const [riskConfirmed, setRiskConfirmed] = useState(false)
  const [alias, setAlias] = useState('')
  const [skippedTables, setSkippedTables] = useState<string[]>([])
  const active = migration?.status === 'applying' || migration?.status === 'rolling_back'
  const canCreatePreview = runtimeMode === 'compatibility'
    && !error
    && !migration?.recoveryTarget
    && (!migration || ['failed', 'rolled_back', 'recovered', 'superseded'].includes(migration.status))

  useEffect(() => {
    setReviewConfirmed(false)
    setRiskConfirmed(false)
    setAlias('')
    setSkippedTables([])
  }, [migration?.migrationId])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(onRefresh, 1_000)
    return () => window.clearInterval(timer)
  }, [active, onRefresh])

  const updateFromResponse = (response: Awaited<ReturnType<typeof api.getDataAccessMigration>>) => {
    if (response.data) onChanged(response.data)
    if (!response.success) {
      toast({
        title: '操作未完成',
        description: response.error?.message ?? '请刷新状态后重试',
        variant: 'destructive',
      })
    }
    return response.success
  }

  const reconcileOperation = async (
    response: Awaited<ReturnType<typeof api.getDataAccessMigration>>
  ) => {
    if (response.data) return updateFromResponse(response)
    if (response.success) return true

    const current = await api.getDataAccessMigration(projectId)
    if (current.data) {
      onChanged(current.data)
      toast({
        title: '已同步运行状态',
        description: current.data.status === 'applying' || current.data.status === 'rolling_back'
          ? '操作仍在服务端执行，可继续查看进度'
          : '已从服务端恢复最新状态',
      })
      return current.success
    }
    updateFromResponse(response)
    return false
  }

  const createPreview = async (skip: string[] = []) => {
    setBusy(true)
    const response = await api.previewDataAccessMigration(projectId, skip)
    const success = updateFromResponse(response)
    setBusy(false)
    if (success) {
      setDialogMode('preview')
      setReviewConfirmed(false)
      setRiskConfirmed(false)
      setAlias('')
      setSkippedTables([])
    }
  }

  const apply = async () => {
    if (!migration) return
    setBusy(true)
    onChanged({
      ...migration,
      status: 'applying',
      phase: 'snapshot_check',
      canApply: false,
      error: null,
    })
    const response = await api.applyDataAccessMigration(projectId, migration.migrationId, {
      sourceDigest: migration.sourceDigest,
      confirmInferredPolicies: reviewConfirmed,
      confirmDestructiveChanges: riskConfirmed,
      ...(alias ? { projectAlias: alias } : {}),
    })
    const success = await reconcileOperation(response)
    setBusy(false)
    if (success && response.data?.status === 'applied') setDialogMode(null)
  }

  const recover = async () => {
    if (!migration?.requiredRecoveryDigest) return
    setBusy(true)
    onChanged({
      ...migration,
      status: migration.recoveryTarget === 'pre_migration' ? 'applying' : 'rolling_back',
      phase: 'restore_permissions',
      error: null,
    })
    const response = await api.recoverDataAccessMigration(projectId, migration.migrationId, {
      expectedRecoveryDigest: migration.requiredRecoveryDigest,
      projectAlias: alias,
    })
    const success = await reconcileOperation(response)
    setBusy(false)
    if (success && response.data && response.data.status !== 'applying' && response.data.status !== 'rolling_back') {
      setDialogMode(null)
    }
  }

  const previewRollback = async () => {
    if (!migration) return
    setBusy(true)
    const response = await api.previewDataAccessMigrationRollback(projectId, migration.migrationId, alias)
    updateFromResponse(response)
    setBusy(false)
  }

  const rollback = async () => {
    if (!migration?.rollbackPreviewDigest) return
    setBusy(true)
    onChanged({
      ...migration,
      status: 'rolling_back',
      phase: 'rollback_snapshot_check',
      canRollback: false,
      rollbackPreviewDigest: null,
      error: null,
    })
    const response = await api.rollbackDataAccessMigration(projectId, migration.migrationId, {
      rollbackPreviewDigest: migration.rollbackPreviewDigest,
      projectAlias: alias,
    })
    const success = await reconcileOperation(response)
    setBusy(false)
    if (success && response.data?.status === 'rolled_back') setDialogMode(null)
  }

  if (loading) {
    return <div className="h-24 animate-pulse border-y bg-muted/30" aria-label="正在加载迁移状态" />
  }

  return (
    <>
      <section className={cn(
        'mb-6 flex flex-col gap-4 border-y px-5 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between',
        migration?.error ? 'border-amber-300 bg-amber-50/60' : 'bg-muted/20'
      )}>
        <div className="flex min-w-0 items-start gap-3">
          {active
            ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-primary" aria-hidden="true" />
            : migration?.error
              ? <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
              : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" aria-hidden="true" />}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">项目级数据访问</h2>
              <Badge variant="outline">{migration ? getMigrationStatusLabel(migration.status) : runtimeMode === 'explicit' ? '已启用' : '兼容模式'}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {statusDescription(runtimeMode, migration, error)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {active && <Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw />刷新状态</Button>}
          {canCreatePreview && (
            <Button size="sm" disabled={busy} onClick={() => void createPreview()}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              {migration ? '重新生成迁移预检' : '生成迁移预检'}
            </Button>
          )}
          {migration?.status === 'preview_ready' && (
            <Button size="sm" onClick={() => setDialogMode('preview')}>查看迁移预检</Button>
          )}
          {migration?.recoveryTarget && (
            <Button size="sm" variant="outline" onClick={() => { setAlias(''); setDialogMode('recovery') }}>
              <RotateCcw />
              {migration.recoveryTarget === 'pre_migration' ? '恢复迁移前状态' : '恢复升级后状态'}
            </Button>
          )}
          {migration?.status === 'applied' && migration.canRollback && (
            <Button size="sm" variant="outline" onClick={() => { setAlias(''); setDialogMode('rollback') }}>
              <RotateCcw />回滚预检
            </Button>
          )}
        </div>
        {active && <ProgressTrack phase={migration.phase} />}
      </section>

      <Dialog open={dialogMode === 'preview'} onOpenChange={(open) => { if (!open && !active && !busy) setDialogMode(null) }}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>数据访问迁移预检</DialogTitle>
            <DialogDescription>逐表确认升级后的访问范围和需要移除的旧能力。</DialogDescription>
          </DialogHeader>
          {migration && <PreviewContent
            tenantId={tenantId}
            projectId={projectId}
            migration={migration}
            skippedTables={skippedTables}
            setSkippedTables={setSkippedTables}
            openOperatorGuide={() => setDialogMode('operator')}
          />}
          {migration && migration.status === 'preview_ready' && (
            <div className="space-y-4 border-t pt-4">
              {migration.summary.inferredOperationCount > 0 && (
                <ConfirmationCheckbox
                  label="我已检查自动迁移的访问规则"
                  checked={reviewConfirmed}
                  onChange={setReviewConfirmed}
                />
              )}
              {migration.summary.destructiveChangeCount > 0 && (
                <ConfirmationCheckbox
                  label="我已了解将移除高风险旧能力"
                  checked={riskConfirmed}
                  onChange={setRiskConfirmed}
                />
              )}
              {requiresAliasConfirmation(migration.summary) && (
                <div className="space-y-2">
                  <Label htmlFor="migration-project-alias">输入项目别名确认</Label>
                  <Input id="migration-project-alias" value={alias} onChange={(event) => setAlias(event.target.value)} autoComplete="off" />
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            {migration && skippedTables.length > 0 && (
              <Button variant="outline" disabled={busy} onClick={() => void createPreview(skippedTables)}>
                重新生成预检
              </Button>
            )}
            <Button
              aria-label="开始升级"
              disabled={!migration?.canApply || busy || !applyConfirmed(migration, reviewConfirmed, riskConfirmed, alias, projectAlias)}
              onClick={() => void apply()}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Check />}
              开始升级
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogMode === 'recovery'} onOpenChange={(open) => { if (!open && !busy) setDialogMode(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{migration?.recoveryTarget === 'pre_migration' ? '恢复迁移前状态' : '恢复升级后状态'}</DialogTitle>
            <DialogDescription>系统将按已保存的安全快照恢复并重新验证访问状态。</DialogDescription>
          </DialogHeader>
          <AliasConfirmation alias={alias} setAlias={setAlias} />
          <DialogFooter>
            <Button disabled={busy || alias !== projectAlias} onClick={() => void recover()}>
              {busy && <Loader2 className="animate-spin" />}确认恢复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogMode === 'rollback'} onOpenChange={(open) => { if (!open && !busy) setDialogMode(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>恢复兼容模式</DialogTitle>
            <DialogDescription>旧访问范围和已移除的高风险能力可能重新生效，请先生成回滚预检。</DialogDescription>
          </DialogHeader>
          <AliasConfirmation alias={alias} setAlias={setAlias} />
          <DialogFooter className="gap-2">
            {!migration?.rollbackPreviewDigest ? (
              <Button disabled={busy || alias !== projectAlias} onClick={() => void previewRollback()}>
                {busy && <Loader2 className="animate-spin" />}生成回滚预检
              </Button>
            ) : (
              <Button variant="destructive" disabled={busy || alias !== projectAlias} onClick={() => void rollback()}>
                {busy && <Loader2 className="animate-spin" />}确认恢复兼容模式
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogMode === 'operator'} onOpenChange={(open) => { if (!open) setDialogMode('preview') }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>运维处理说明</DialogTitle>
            <DialogDescription>这些规则无法由简化配置安全表达，需要由部署管理员先完成处理。</DialogDescription>
          </DialogHeader>
          <ol className="space-y-3 text-sm">
            <li>1. 先导出当前项目的数据访问备份。</li>
            <li>2. 根据阻断项改为项目内可管理的访问范围，或移除无效绑定。</li>
            <li>3. 回到本页重新生成迁移预检。</li>
          </ol>
        </DialogContent>
      </Dialog>
    </>
  )
}

function PreviewContent({
  tenantId,
  projectId,
  migration,
  skippedTables,
  setSkippedTables,
  openOperatorGuide,
}: {
  tenantId: string
  projectId: string
  migration: ProjectDataAccessMigrationReport
  skippedTables: string[]
  setSkippedTables: (tables: string[]) => void
  openOperatorGuide: () => void
}) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 border-y sm:grid-cols-4">
        <Metric label="数据表" value={migration.summary.totalTables} />
        <Metric label="自动迁移" value={migration.summary.migratedTables} />
        <Metric label="需处理" value={migration.summary.blockerCount} />
        <Metric label="风险变更" value={migration.summary.destructiveChangeCount} />
      </div>
      {migration.blockers.length > 0 && (
        <div className="space-y-3 border-l-2 border-amber-500 bg-amber-50/60 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" />预检存在阻断项</div>
            <Button variant="link" size="sm" onClick={openOperatorGuide}>查看运维处理说明</Button>
          </div>
          {migration.blockers.map((blocker, index) => (
            <div key={`${blocker.tableName}-${blocker.reason}-${index}`} className="flex items-center justify-between gap-3 text-sm">
              <span>{blocker.tableName ? `${blocker.tableName}：` : ''}{getBlockerLabel(blocker.reason)}</span>
              {blocker.tableName && (
                <Link className="text-primary hover:underline" href={`/t/${encodeURIComponent(tenantId)}/p/${encodeURIComponent(projectId)}/tables/${encodeURIComponent(blocker.tableName)}?tab=access&scope=default`}>
                  配置
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="divide-y rounded-md border">
        {migration.tables.map((table) => {
          const inferred = table.inferredOperations.length > 0
          const skipped = skippedTables.includes(table.tableName)
          return (
            <div key={table.tableName} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="font-mono text-sm font-medium">{table.tableName}</div>
                <div className="mt-1 text-sm text-muted-foreground">{summarizeMigrationTableAccess(table.authenticated, table.anonymousRead)}</div>
              </div>
              {inferred && (
                <label className="flex shrink-0 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={skipped}
                    onChange={(event) => setSkippedTables(event.target.checked
                      ? [...skippedTables, table.tableName]
                      : skippedTables.filter((item) => item !== table.tableName))}
                  />
                  迁移后保持关闭
                </label>
              )}
            </div>
          )
        })}
      </div>
      {migration.destructiveChanges.length > 0 && (
        <div className="flex gap-3 border-l-2 border-destructive bg-destructive/5 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">升级将收紧旧访问能力</p>
            <p className="mt-1 text-muted-foreground">匿名写入或认证用户聚合访问将被移除，共 {migration.destructiveChanges.length} 项。</p>
          </div>
        </div>
      )}
    </div>
  )
}

function ProgressTrack({ phase }: { phase: ProjectDataAccessMigrationReport['phase'] }) {
  const progress = getMigrationPhaseProgress(phase)
  return (
    <div className="w-full sm:basis-full" aria-label={`迁移进度：${progress.label}`}>
      <div className="grid grid-cols-6 gap-1">
        {progress.steps.map((step, index) => (
          <div key={step.label} className="min-w-0">
            <div className={cn('h-1.5 rounded-sm bg-muted', index <= progress.index && 'bg-primary')} />
            <div className={cn('mt-1 truncate text-center text-[11px] text-muted-foreground', index === progress.index && 'font-medium text-foreground')}>{step.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ConfirmationCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>
}

function AliasConfirmation({ alias, setAlias }: { alias: string; setAlias: (value: string) => void }) {
  return <div className="space-y-2"><Label htmlFor="recovery-project-alias">输入项目别名确认</Label><Input id="recovery-project-alias" value={alias} onChange={(event) => setAlias(event.target.value)} autoComplete="off" /></div>
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="border-r px-3 py-2 last:border-r-0"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-lg font-semibold tabular-nums">{value}</div></div>
}

function applyConfirmed(
  migration: ProjectDataAccessMigrationReport | null,
  review: boolean,
  risk: boolean,
  alias: string,
  projectAlias: string
): boolean {
  if (!migration) return false
  if (migration.summary.inferredOperationCount > 0 && !review) return false
  if (migration.summary.destructiveChangeCount > 0 && !risk) return false
  if (requiresAliasConfirmation(migration.summary) && alias !== projectAlias) return false
  return true
}

function statusDescription(
  runtimeMode: 'compatibility' | 'explicit',
  migration: ProjectDataAccessMigrationReport | null,
  error: string | null
): string {
  if (error) return error
  if (migration?.error) return migration.error.message
  if (migration?.status === 'applying') return '访问规则正在升级，可安全刷新页面查看最新进度。'
  if (migration?.status === 'rolling_back') return '正在恢复兼容模式，可安全刷新页面查看最新进度。'
  if (migration?.status === 'preview_ready') return '预检已保存，请检查逐表访问范围后开始升级。'
  if (runtimeMode === 'explicit') return '应用请求已使用项目隔离的访问规则。'
  return '生成预检后，可将旧访问规则迁移为项目隔离规则。'
}
