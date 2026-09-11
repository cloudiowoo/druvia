'use client';

import { KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

export interface DeviceWipeConfigValue {
  enabled: boolean;
  hooksReady: boolean;
  activeKeyId: string | null;
  verificationKeyCount: number;
}

interface DeviceWipeConfigPanelProps {
  config: DeviceWipeConfigValue | null;
  loading: boolean;
  saving: boolean;
  rotating: boolean;
  onToggle: (enabled: boolean) => void;
  onRotate: () => void;
}

export function DeviceWipeConfigPanel({
  config,
  loading,
  saving,
  rotating,
  onToggle,
  onRotate,
}: DeviceWipeConfigPanelProps) {
  const enabled = config?.enabled ?? false;
  const hooksReady = config?.hooksReady ?? false;

  return (
    <div className="mt-4 border rounded-lg">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b bg-muted/50 p-4">
        <div className="min-w-0">
          <h3 className="font-medium">设备擦除指令</h3>
          <p className="text-sm text-muted-foreground">
            {hooksReady ? '项目设备擦除接口已就绪' : '项目设备擦除接口未就绪'}
          </p>
        </div>
        {loading ? (
          <Skeleton className="h-6 w-10" />
        ) : (
          <Switch
            aria-label="启用设备擦除指令"
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={saving || (!hooksReady && !enabled)}
          />
        )}
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="min-w-0 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <ShieldCheck className={`h-4 w-4 ${enabled ? 'text-green-600' : 'text-muted-foreground'}`} />
            <span>{enabled ? '设备可领取已签名的擦除指令' : '新设备绑定已停用'}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <KeyRound className="h-4 w-4 shrink-0" />
            <span className="shrink-0">当前密钥</span>
            <code className="min-w-0 break-all text-xs text-foreground">
              {config?.activeKeyId ?? '未生成'}
            </code>
            <span className="shrink-0">({config?.verificationKeyCount ?? 0} 个可验证)</span>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={onRotate}
          disabled={!enabled || !hooksReady || rotating}
          aria-label="轮换签名密钥"
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${rotating ? 'animate-spin' : ''}`} />
          轮换密钥
        </Button>
      </div>
    </div>
  );
}
