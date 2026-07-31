'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Power,
  RefreshCw,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import { api, type DruviaUpdateOperation, type DruviaUpdateStatus } from '@/lib/api';

type ActionKey = 'check' | 'download' | 'apply' | 'rollback' | 'restart';
type StepState = 'complete' | 'active' | 'pending' | 'failed';

const phaseLabels: Record<DruviaUpdateStatus['phase'], string> = {
  idle: '空闲',
  checking: '检查中',
  available: '有新版本',
  downloading: '更新中',
  ready_to_apply: '待应用',
  applying: '应用中',
  restarting: '重启中',
  verifying: '验证中',
  finalizing: '收尾中',
  succeeded: '已完成',
  failed: '失败',
  rolled_back: '已回滚',
};

const updateSteps = [
  { phase: 'checking', label: '检查' },
  { phase: 'downloading', label: '下载' },
  { phase: 'ready_to_apply', label: '待应用' },
  { phase: 'applying', label: '应用' },
  { phase: 'verifying', label: '验证' },
  { phase: 'finalizing', label: '收尾' },
  { phase: 'succeeded', label: '完成' },
] as const;

const busyPhases = new Set<DruviaUpdateStatus['phase']>([
  'checking',
  'downloading',
  'applying',
  'restarting',
  'verifying',
  'finalizing',
]);

const phaseStepMap: Partial<Record<DruviaUpdateStatus['phase'], number>> = {
  idle: 0,
  checking: 0,
  available: 0,
  downloading: 1,
  ready_to_apply: 2,
  applying: 3,
  restarting: 3,
  verifying: 4,
  finalizing: 5,
  succeeded: 6,
  failed: 0,
  rolled_back: 0,
};

function phaseStepIndex(status: DruviaUpdateStatus): number {
  return phaseStepMap[status.phase] ?? 0;
}

function phaseProgressPercent(status: DruviaUpdateStatus): number {
  if (status.phase === 'idle' || status.phase === 'available') return 0;
  if (status.phase === 'failed' || status.phase === 'rolled_back') return 0;

  const lastStepIndex = updateSteps.length - 1;
  return Math.round((phaseStepIndex(status) / lastStepIndex) * 100);
}

function stepState(status: DruviaUpdateStatus, index: number): StepState {
  const activeIndex = phaseStepIndex(status);
  if (status.phase === 'failed' && index === activeIndex) return 'failed';
  if (status.phase === 'succeeded' || index < activeIndex) return 'complete';
  if (index === activeIndex && status.phase !== 'idle' && status.phase !== 'available') return 'active';
  return 'pending';
}

function stepClassName(state: StepState): string {
  if (state === 'complete') return 'border-green-600 bg-green-600 text-white';
  if (state === 'active') return 'border-blue-600 bg-blue-600 text-white shadow-sm';
  if (state === 'failed') return 'border-red-600 bg-red-600 text-white';
  return 'border-muted-foreground/25 bg-background text-muted-foreground';
}

function statusBadgeClass(phase: DruviaUpdateStatus['phase']): string {
  if (phase === 'failed') return 'border-red-200 bg-red-50 text-red-700';
  if (phase === 'available' || phase === 'ready_to_apply') return 'border-blue-200 bg-blue-50 text-blue-700';
  if (phase === 'succeeded') return 'border-green-200 bg-green-50 text-green-700';
  if (phase === 'rolled_back') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-slate-200 bg-slate-50 text-slate-700';
}

function statusMessageClass(phase: DruviaUpdateStatus['phase']): string {
  if (phase === 'available' || phase === 'ready_to_apply') return 'border-blue-200 bg-blue-50 text-blue-900';
  if (phase === 'succeeded' || phase === 'idle') return 'border-green-200 bg-green-50 text-green-900';
  if (phase === 'rolled_back') return 'border-amber-200 bg-amber-50 text-amber-900';
  if (busyPhases.has(phase)) return 'border-slate-200 bg-slate-50 text-slate-800';
  return 'border-gray-200 bg-gray-50 text-gray-800';
}

function formatStatusMessage(status: DruviaUpdateStatus): string | null {
  if (status.error?.message) return status.error.message;
  if (!status.message) return null;

  if (status.message === 'Current version is up to date') {
    return '已是最新版本';
  }
  if (status.message === 'Services restarted') {
    return '服务已重启';
  }
  if (status.message === 'Verifying services after update') {
    return '正在验证更新后的服务状态';
  }
  if (status.message === 'Verifying services after rollback') {
    return '正在验证回滚后的服务状态';
  }
  if (status.phase === 'available') {
    return `发现新版本 ${status.availableVersion ?? ''}`.trim();
  }
  if (status.phase === 'ready_to_apply') {
    return `版本 ${status.availableVersion ?? ''} 已下载，等待重启应用`.trim();
  }

  const finalizerScheduledMatch = status.message.match(/^Updated to (.+); updater finalizer scheduled/);
  if (finalizerScheduledMatch) {
    return `已更新到 ${finalizerScheduledMatch[1]}，正在准备 updater 自更新`;
  }

  const finalizerRunningMatch = status.message.match(/^Updated to (.+); updater finalizer running/);
  if (finalizerRunningMatch) {
    return `已更新到 ${finalizerRunningMatch[1]}，正在替换 updater`;
  }

  const finalizerCompletedMatch = status.message.match(/^Updated to (.+); updater finalizer completed/);
  if (finalizerCompletedMatch) {
    return `已更新到 ${finalizerCompletedMatch[1]}，updater 自更新已完成`;
  }

  const finalizerFailedAfterStartMatch = status.message.match(/^Updated to (.+); updater finalizer failed:/);
  if (finalizerFailedAfterStartMatch) {
    return `已更新到 ${finalizerFailedAfterStartMatch[1]}，但 updater 自更新执行失败，可稍后手动恢复`;
  }

  const finalizerFailedMatch = status.message.match(/^Updated to (.+); updater finalizer failed/);
  if (finalizerFailedMatch) {
    return `已更新到 ${finalizerFailedMatch[1]}，但 updater 自更新调度失败，可稍后手动恢复`;
  }

  const selfUpdateFailedMatch = status.message.match(/^Updated to (.+); updater self-update failed/);
  if (selfUpdateFailedMatch) {
    return `已更新到 ${selfUpdateFailedMatch[1]}，但 updater 自更新失败，可稍后手动重试`;
  }

  const updatedMatch = status.message.match(/^Updated to (.+)$/);
  if (updatedMatch) {
    return `已更新到 ${updatedMatch[1]}`;
  }

  if (status.message.startsWith('Rolled back')) {
    return '已回滚到升级前版本';
  }

  return status.message;
}

function SummaryItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 min-w-0 text-sm">{value}</div>
    </div>
  );
}

export function SystemUpdatePanel() {
  const [status, setStatus] = useState<DruviaUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<ActionKey | null>(null);
  const pendingOperationRef = useRef<string | null>(null);
  const lastCompletedStatusRef = useRef<string | null>(null);
  const statusPhase = status?.phase;

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getSystemUpdateStatus();
      if (res.success && res.data) {
        setStatus(res.data);
      } else {
        toast({ title: '读取更新状态失败', description: res.error?.message, variant: 'destructive' });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!statusPhase || !busyPhases.has(statusPhase)) return;

    let cancelled = false;
    async function pollStatus() {
      const res = await api.getSystemUpdateStatus();
      if (!cancelled && res.success && res.data) {
        setStatus(res.data);
      }
    }

    const timer = window.setInterval(pollStatus, 2 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [statusPhase]);

  useEffect(() => {
    if (!status || busyPhases.has(status.phase) || !pendingOperationRef.current || !status.finishedAt) return;

    const completionKey = `${status.phase}:${status.finishedAt}:${status.message ?? ''}:${status.error?.message ?? ''}`;
    if (lastCompletedStatusRef.current === completionKey) return;

    lastCompletedStatusRef.current = completionKey;
    pendingOperationRef.current = null;

    const message = formatStatusMessage(status);
    if (!message) return;

    if (status.error) {
      toast({ title: '更新操作失败', description: message, variant: 'destructive' });
      return;
    }

    toast({ title: message });
  }, [status]);

  const busy = Boolean(action) || (status ? busyPhases.has(status.phase) : false);
  const canDownload = status?.phase === 'available' || status?.phase === 'failed' || status?.phase === 'rolled_back';
  const canApply = status?.phase === 'ready_to_apply';
  const canRollback = status?.phase === 'failed';
  const statusMessage = status ? formatStatusMessage(status) : null;
  const progressPercent = status ? phaseProgressPercent(status) : 0;

  const migrationText = useMemo(() => {
    if (!status?.migration) return '无';
    const backup = status.migration.requiresBackup ? '需要备份' : '不强制备份';
    return `${status.migration.from} -> ${status.migration.to}，${backup}`;
  }, [status?.migration]);

  const detailRows = useMemo(() => {
    if (!status) return [];
    return [
      { label: '更新功能', value: status.enabled ? '已启用' : '未启用' },
      { label: '当前版本', value: status.currentVersion },
      { label: '可用版本', value: status.availableVersion ?? '-' },
      { label: '发布渠道', value: status.channel },
      { label: '当前状态', value: phaseLabels[status.phase] },
      { label: '操作 ID', value: status.operationId ?? '-' },
      { label: '开始时间', value: status.startedAt ?? '-' },
      { label: '完成时间', value: status.finishedAt ?? '-' },
      { label: '迁移信息', value: migrationText },
      { label: '原始消息', value: status.message ?? '-' },
      { label: '错误信息', value: status.error?.message ?? '-' },
    ];
  }, [migrationText, status]);

  async function runOperation(
    key: ActionKey,
    operation: () => Promise<{ success: boolean; data?: DruviaUpdateOperation; error?: { message: string } }>,
    successTitle: string
  ) {
    setAction(key);
    try {
      const res = await operation();
      if (res.success) {
        if (res.data?.operationId) {
          pendingOperationRef.current = res.data.operationId;
          lastCompletedStatusRef.current = null;
        }
        if (res.data?.status) setStatus(res.data.status);
        toast({ title: successTitle });
      } else {
        toast({ title: '操作失败', description: res.error?.message, variant: 'destructive' });
      }
    } finally {
      setAction(null);
    }
  }

  return (
    <Card className="lg:col-span-2 overflow-hidden">
      <CardHeader className="border-b bg-muted/20">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <RotateCw className="h-4 w-4 text-muted-foreground" />
              系统更新
            </CardTitle>
            <CardDescription className="mt-1">当前版本、发布渠道与更新操作</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refreshStatus} disabled={loading || busy}>
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            刷新
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 pt-6">
        {loading && !status ? (
          <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : status ? (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
              <SummaryItem label="当前版本" value={<span className="font-mono">{status.currentVersion}</span>} />
              <SummaryItem label="可用版本" value={<span className="font-mono">{status.availableVersion ?? '-'}</span>} />
              <SummaryItem label="渠道" value={status.channel} />
              <SummaryItem
                label="状态"
                value={(
                  <Badge variant="outline" className={statusBadgeClass(status.phase)}>
                    {phaseLabels[status.phase]}
                  </Badge>
                )}
              />
            </div>

            <div className="rounded-md border bg-background p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">更新进度</p>
                  <p className="text-xs text-muted-foreground">{phaseLabels[status.phase]}</p>
                </div>
                <span className="font-mono text-sm text-muted-foreground">{progressPercent}%</span>
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-blue-600 transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                {updateSteps.map((step, index) => {
                  const state = stepState(status, index);
                  return (
                    <div key={step.phase} className="min-w-0">
                      <div className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full border text-xs font-medium ${stepClassName(state)}`}>
                        {state === 'complete' ? <Check className="h-4 w-4" /> : index + 1}
                      </div>
                      <p className="mt-1 truncate text-center text-xs text-muted-foreground">{step.label}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <SummaryItem label="迁移" value={migrationText} />
              <SummaryItem
                label="发布说明"
                value={status.releaseNotesUrl ? (
                  <a
                    className="inline-flex max-w-full items-center gap-1 truncate text-blue-600 hover:underline"
                    href={status.releaseNotesUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="truncate">{status.releaseNotesUrl}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  </a>
                ) : '-'}
              />
            </div>

            {statusMessage && !status.error && (
              <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${statusMessageClass(status.phase)}`}>
                {busyPhases.has(status.phase) ? (
                  <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <div>
                  <p className="font-medium">更新状态</p>
                  <p className="mt-0.5">{statusMessage}</p>
                </div>
              </div>
            )}

            {status.error && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{status.error.message}</span>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4" />
            暂无更新状态
          </div>
        )}
      </CardContent>

      {status && (
        <CardFooter className="flex flex-col items-stretch gap-3 border-t bg-muted/20 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => runOperation('check', () => api.checkSystemUpdate(), '已开始检查更新')}
              disabled={busy}
            >
              <RefreshCw className={action === 'check' ? 'animate-spin' : ''} />
              检查更新
            </Button>
            <Button
              onClick={() => runOperation('download', () => api.downloadSystemUpdate(), '已开始更新')}
              disabled={busy || !canDownload}
            >
              <Download />
              更新
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="secondary" disabled={busy || !canApply}>
                  <RotateCw />
                  重启并应用
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>重启并应用更新</AlertDialogTitle>
                  <AlertDialogDescription>
                    将切换到 {status.availableVersion ?? '已暂存版本'} 并重建核心服务。{migrationText !== '无' ? `迁移：${migrationText}。` : ''}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => runOperation('apply', () => api.applySystemUpdate(), '已开始应用更新')}>
                    确认应用
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={busy}>
                  <Power />
                  重启服务
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>重启服务</AlertDialogTitle>
                  <AlertDialogDescription>
                    将重启 API、Admin 与 Worker 服务，当前连接会短暂中断。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => runOperation('restart', () => api.restartSystemServices(), '已开始重启服务')}>
                    确认重启
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button
              variant="outline"
              onClick={() => runOperation('rollback', () => api.rollbackSystemUpdate(), '已开始回滚')}
              disabled={busy || !canRollback}
            >
              <RotateCcw />
              回滚
            </Button>
          </div>

          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">
                <FileText />
                更新详情
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>更新详情</DialogTitle>
                <DialogDescription>当前发布状态与操作信息</DialogDescription>
              </DialogHeader>
              <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
                <dl className="divide-y rounded-md border text-sm">
                  {detailRows.map((item) => (
                    <div key={item.label} className="grid gap-1 px-4 py-3 sm:grid-cols-[120px_minmax(0,1fr)]">
                      <dt className="text-muted-foreground">{item.label}</dt>
                      <dd className="min-w-0 break-all font-mono">{item.value}</dd>
                    </div>
                  ))}
                </dl>
                {status.releaseNotesUrl && (
                  <Button asChild variant="outline" className="w-full justify-center">
                    <a href={status.releaseNotesUrl} target="_blank" rel="noreferrer">
                      <ExternalLink />
                      查看发布说明
                    </a>
                  </Button>
                )}
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">关闭</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardFooter>
      )}
    </Card>
  );
}
