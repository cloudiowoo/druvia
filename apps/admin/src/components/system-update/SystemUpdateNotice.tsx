'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertTriangle, Download, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, type DruviaUpdateStatus } from '@/lib/api';
import { useAuth } from '@/lib/auth';

const NOTICE_PHASES = new Set<DruviaUpdateStatus['phase']>([
  'available',
  'ready_to_apply',
  'failed',
  'rolled_back',
]);

function noticeText(status: DruviaUpdateStatus): string {
  if (status.phase === 'ready_to_apply') {
    return `Druvia ${status.availableVersion ?? ''} 已准备应用`;
  }
  if (status.phase === 'failed') {
    return '系统更新失败';
  }
  if (status.phase === 'rolled_back') {
    return '系统已回滚到升级前版本';
  }
  return `发现 Druvia ${status.availableVersion ?? ''} 新版本`;
}

export function SystemUpdateNotice() {
  const { user } = useAuth();
  const [status, setStatus] = useState<DruviaUpdateStatus | null>(null);

  useEffect(() => {
    if (user?.role !== 'super_admin') return;

    let cancelled = false;
    async function loadStatus() {
      const res = await api.getSystemUpdateStatus();
      if (!cancelled && res.success) {
        setStatus(res.data && NOTICE_PHASES.has(res.data.phase) ? res.data : null);
      }
    }

    void loadStatus();
    const timer = window.setInterval(loadStatus, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [user?.role]);

  if (user?.role !== 'super_admin' || !status) return null;

  const isFailure = status.phase === 'failed' || status.phase === 'rolled_back';
  const Icon = status.phase === 'ready_to_apply' ? RotateCw : isFailure ? AlertTriangle : Download;

  return (
    <div className={`mx-8 mt-4 rounded-md border px-4 py-3 ${
      isFailure ? 'border-red-200 bg-red-50 text-red-900' : 'border-blue-200 bg-blue-50 text-blue-950'
    }`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{noticeText(status)}</p>
            {status.message && (
              <p className="mt-0.5 truncate text-xs opacity-80">{status.message}</p>
            )}
          </div>
        </div>
        <Button asChild size="sm" variant="outline" className="shrink-0 bg-white">
          <Link href="/settings">
            <RotateCw className="h-4 w-4" />
            系统更新
          </Link>
        </Button>
      </div>
    </div>
  );
}
