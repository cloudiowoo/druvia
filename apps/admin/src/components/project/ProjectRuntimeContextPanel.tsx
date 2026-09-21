'use client'

import { useEffect, useState } from 'react'
import { ServerCog } from 'lucide-react'
import type { ProjectRuntimeContext, ServiceEnvironment } from '@druvia/shared'
import { Button } from '@/components/ui/button'

const SERVICE_ENVIRONMENT_OPTIONS: Array<{ value: ServiceEnvironment; label: string }> = [
  { value: 'local', label: '本地' },
  { value: 'sandbox', label: 'Sandbox' },
  { value: 'testflight', label: 'TestFlight' },
  { value: 'production', label: '生产' },
]

interface ProjectRuntimeContextPanelProps {
  context: ProjectRuntimeContext | null
  loading: boolean
  saving: boolean
  canManage: boolean
  onSave: (serviceEnvironment: ServiceEnvironment) => void
  onDisable: () => void
}

export function ProjectRuntimeContextPanel({
  context,
  loading,
  saving,
  canManage,
  onSave,
  onDisable,
}: ProjectRuntimeContextPanelProps) {
  const [serviceEnvironment, setServiceEnvironment] = useState<ServiceEnvironment>(
    context?.enabled ? context.serviceEnvironment : 'local',
  )

  useEffect(() => {
    setServiceEnvironment(context?.enabled ? context.serviceEnvironment : 'local')
  }, [context])

  const enabled = context?.enabled === true

  return (
    <section className="border rounded-lg" aria-label="项目运行环境">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <ServerCog className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h2 className="font-medium">服务运行环境</h2>
        </div>
        <span className={`rounded-md px-2 py-1 text-xs font-medium ${
          enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground'
        }`}>
          {enabled ? '已启用' : '未配置'}
        </span>
      </div>

      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="grid gap-2">
          <label htmlFor="service-environment" className="text-sm font-medium">服务环境</label>
          <select
            id="service-environment"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
            value={serviceEnvironment}
            onChange={(event) => setServiceEnvironment(event.target.value as ServiceEnvironment)}
            disabled={loading || saving || !canManage}
          >
            {SERVICE_ENVIRONMENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {enabled ? `版本 ${context.revision}` : '未写入项目运行环境'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => onSave(serviceEnvironment)}
            disabled={loading || saving || !canManage}
            aria-label="保存运行环境"
          >
            {saving ? '保存中...' : '保存'}
          </Button>
          <Button
            variant="outline"
            onClick={onDisable}
            disabled={loading || saving || !canManage || !enabled}
            aria-label="停用运行环境"
          >
            停用
          </Button>
        </div>
      </div>
    </section>
  )
}
