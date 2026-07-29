'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Power,
  RefreshCw,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { toast } from '@/hooks/use-toast';
import { api, type DruviaUpdateOperation, type DruviaUpdateStatus } from '@/lib/api';

type ActionKey = 'check' | 'download' | 'apply' | 'rollback' | 'restart';

const phaseLabels: Record<DruviaUpdateStatus['phase'], string> = {
  idle: '空闲',
  checking: '检查中',
  available: '有新版本',
  downloading: '更新中',
  ready_to_apply: '待应用',
  applying: '应用中',
  restarting: '重启中',
  verifying: '验证中',
  succeeded: '已完成',
  failed: '失败',
  rolled_back: '已回滚',
};

const busyPhases = new Set<DruviaUpdateStatus['phase']>([
  'checking',
  'downloading',
  'applying',
  'restarting',
  'verifying',
]);

function statusBadgeClass(phase: DruviaUpdateStatus['phase']): string {
  if (phase === 'failed') return 'border-red-200 bg-red-50 text-red-700';
  if (phase === 'available' || phase === 'ready_to_apply') return 'border-blue-200 bg-blue-50 text-blue-700';
  if (phase === 'succeeded') return 'border-green-200 bg-green-50 text-green-700';
  if (phase === 'rolled_back') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-gray-200 bg-gray-50 text-gray-700';
}

export function SystemUpdatePanel() {
  const [status, setStatus] = useState<DruviaUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<ActionKey | null>(null);

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
    if (!status || !busyPhases.has(status.phase)) return;

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
  }, [status?.phase]);

  const busy = Boolean(action) || (status ? busyPhases.has(status.phase) : false);
  const canDownload = status?.phase === 'available' || status?.phase === 'failed' || status?.phase === 'rolled_back';
  const canApply = status?.phase === 'ready_to_apply';
  const canRollback = status?.phase === 'failed';

  const migrationText = useMemo(() => {
    if (!status?.migration) return '无';
    const backup = status.migration.requiresBackup ? '需要备份' : '不强制备份';
    return `${status.migration.from} -> ${status.migration.to}，${backup}`;
  }, [status?.migration]);

  async function runOperation(
    key: ActionKey,
    operation: () => Promise<{ success: boolean; data?: DruviaUpdateOperation; error?: { message: string } }>,
    successTitle: string
  ) {
    setAction(key);
    try {
      const res = await operation();
      if (res.success) {
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
    <div className="card lg:col-span-2">
      <div className="card-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold">系统更新</h2>
          <p className="mt-1 text-sm text-gray-500">当前版本、发布渠道与更新操作</p>
        </div>
        <Button variant="outline" size="sm" onClick={refreshStatus} disabled={loading || busy}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          刷新
        </Button>
      </div>

      <div className="card-body space-y-5">
        {loading && !status ? (
          <div className="py-6 text-center text-sm text-gray-500">加载中...</div>
        ) : status ? (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border p-3">
                <p className="text-xs text-gray-500">当前版本</p>
                <p className="mt-1 font-mono text-sm">{status.currentVersion}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-gray-500">可用版本</p>
                <p className="mt-1 font-mono text-sm">{status.availableVersion ?? '-'}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-gray-500">渠道</p>
                <p className="mt-1 text-sm">{status.channel}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-gray-500">状态</p>
                <Badge variant="outline" className={`mt-1 ${statusBadgeClass(status.phase)}`}>
                  {phaseLabels[status.phase]}
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-md border p-3">
                <p className="text-xs text-gray-500">迁移</p>
                <p className="mt-1 text-sm">{migrationText}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-gray-500">发布说明</p>
                {status.releaseNotesUrl ? (
                  <a className="mt-1 block truncate text-sm text-blue-600 hover:underline" href={status.releaseNotesUrl} target="_blank" rel="noreferrer">
                    {status.releaseNotesUrl}
                  </a>
                ) : (
                  <p className="mt-1 text-sm">-</p>
                )}
              </div>
            </div>

            {status.error && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{status.error.message}</span>
              </div>
            )}

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
                      将切换到已暂存版本并重建核心服务。
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
                      将重启 API、Admin 与 Worker 服务。
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
          </>
        ) : (
          <div className="flex items-center gap-2 py-6 text-sm text-gray-500">
            <CheckCircle2 className="h-4 w-4" />
            暂无更新状态
          </div>
        )}
      </div>
    </div>
  );
}
