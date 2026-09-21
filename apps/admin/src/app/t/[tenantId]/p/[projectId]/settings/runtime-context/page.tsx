'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import type { ProjectRuntimeContext, ServiceEnvironment } from '@druvia/shared'
import { DashboardLayout } from '@/components/DashboardLayout'
import { ProjectRuntimeContextPanel } from '@/components/project/ProjectRuntimeContextPanel'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useProjectAccess } from '@/hooks/use-project-access'
import { api } from '@/lib/api'
import { useAppStore } from '@/store'

export default function ProjectRuntimeContextPage() {
  const params = useParams()
  const tenantId = params.tenantId as string
  const projectId = params.projectId as string
  const { currentTenant, currentProject } = useAppStore()
  const { can } = useProjectAccess()
  const [context, setContext] = useState<ProjectRuntimeContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [showDisableDialog, setShowDisableDialog] = useState(false)

  const loadContext = useCallback(async () => {
    setLoading(true)
    setError('')
    const result = await api.getProjectRuntimeContext(projectId)
    if (result.success && result.data) {
      setContext(result.data as ProjectRuntimeContext)
    } else {
      setError(result.error?.message || '加载项目运行环境失败')
    }
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    void loadContext()
  }, [loadContext])

  const handleSave = async (serviceEnvironment: ServiceEnvironment) => {
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      const result = await api.updateProjectRuntimeContext(projectId, serviceEnvironment)
      if (!result.success || !result.data) {
        throw new Error(result.error?.message || '保存项目运行环境失败')
      }
      setContext(result.data as ProjectRuntimeContext)
      setSuccess('已保存')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存项目运行环境失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async () => {
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      const result = await api.disableProjectRuntimeContext(projectId)
      if (!result.success || !result.data) {
        throw new Error(result.error?.message || '停用项目运行环境失败')
      }
      setContext(result.data as ProjectRuntimeContext)
      setSuccess('已停用')
      setShowDisableDialog(false)
    } catch (disableError) {
      setError(disableError instanceof Error ? disableError.message : '停用项目运行环境失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <DashboardLayout isProjectLevel={true}>
      <div className="mb-6">
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">{currentTenant?.name}</Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/p/${projectId}`} className="hover:text-foreground">{currentProject?.name}</Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/p/${projectId}/settings`} className="hover:text-foreground">设置</Link>
          <span>/</span>
          <span>运行环境</span>
        </div>
        <h1 className="text-2xl font-bold">运行环境</h1>
      </div>

      <div className="max-w-2xl space-y-4">
        {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        {success && <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{success}</p>}
        <ProjectRuntimeContextPanel
          context={context}
          loading={loading}
          saving={saving}
          canManage={can('runtime_context:manage')}
          onSave={handleSave}
          onDisable={() => setShowDisableDialog(true)}
        />
      </div>

      <AlertDialog open={showDisableDialog} onOpenChange={setShowDisableDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>停用项目运行环境</AlertDialogTitle>
            <AlertDialogDescription>
              新请求将不再注入服务环境上下文。已建立的 Realtime 连接将在刷新令牌后生效。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisable} disabled={saving}>
              {saving ? '停用中...' : '确认停用'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  )
}
