'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { DashboardLayout } from '@/components/DashboardLayout'
import { ProjectDataAccessOverviewPanel } from '@/components/data-access/ProjectDataAccessOverview'
import { api } from '@/lib/api'
import type { ProjectDataAccessOverview } from '@/lib/project-data-access-overview'
import { useAppStore } from '@/store'

export default function ProjectDataAccessOverviewPage() {
  const params = useParams()
  const tenantId = params.tenantId as string
  const projectId = params.projectId as string
  const { currentTenant, currentProject } = useAppStore()
  const [overview, setOverview] = useState<ProjectDataAccessOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.getProjectDataAccessOverview(projectId)
      if (!response.success || !response.data) {
        throw new Error(response.error?.message || '加载数据访问状态失败')
      }
      setOverview(response.data)
    } catch (loadError) {
      setOverview(null)
      setError(loadError instanceof Error ? loadError.message : '加载数据访问状态失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  return (
    <DashboardLayout isProjectLevel={true}>
      <div className="mb-6">
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">
            {currentTenant?.name}
          </Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/p/${projectId}`} className="hover:text-foreground">
            {currentProject?.name}
          </Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/p/${projectId}/settings`} className="hover:text-foreground">
            设置
          </Link>
          <span>/</span>
          <span>数据访问</span>
        </div>
        <h1 className="text-2xl font-bold">数据访问</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          默认 Schema <span className="font-mono">{overview?.schemaName || currentProject?.schemaName || '-'}</span>
        </p>
      </div>

      <ProjectDataAccessOverviewPanel
        tenantId={tenantId}
        projectId={projectId}
        overview={overview}
        loading={loading}
        error={error}
        onRetry={() => void loadOverview()}
      />
    </DashboardLayout>
  )
}
