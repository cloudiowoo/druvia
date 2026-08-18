'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { DashboardLayout } from '@/components/DashboardLayout'
import { ProjectDataAccessOverviewPanel } from '@/components/data-access/ProjectDataAccessOverview'
import { ProjectDataAccessMigration } from '@/components/data-access/ProjectDataAccessMigration'
import { api } from '@/lib/api'
import type { ProjectDataAccessOverview } from '@/lib/project-data-access-overview'
import type { ProjectDataAccessMigrationReport } from '@/lib/project-data-access-migration'
import { useAppStore } from '@/store'

export default function ProjectDataAccessOverviewPage() {
  const params = useParams()
  const tenantId = params.tenantId as string
  const projectId = params.projectId as string
  const { currentTenant, currentProject } = useAppStore()
  const [overview, setOverview] = useState<ProjectDataAccessOverview | null>(null)
  const [migration, setMigration] = useState<ProjectDataAccessMigrationReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadPage = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [overviewResponse, migrationResponse] = await Promise.all([
        api.getProjectDataAccessOverview(projectId),
        api.getDataAccessMigration(projectId),
      ])
      if (!overviewResponse.success || !overviewResponse.data) {
        throw new Error(overviewResponse.error?.message || '加载数据访问状态失败')
      }
      if (!migrationResponse.success) {
        throw new Error(migrationResponse.error?.message || '加载迁移状态失败')
      }
      setOverview(overviewResponse.data)
      setMigration(migrationResponse.data ?? null)
    } catch (loadError) {
      setOverview(null)
      setError(loadError instanceof Error ? loadError.message : '加载数据访问状态失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const refreshMigration = useCallback(async () => {
    const response = await api.getDataAccessMigration(projectId)
    if (response.success) setMigration(response.data ?? null)
  }, [projectId])

  const handleMigrationChanged = useCallback((next: ProjectDataAccessMigrationReport) => {
    setMigration(next)
    void api.getProjectDataAccessOverview(projectId).then((response) => {
      if (response.success && response.data) setOverview(response.data)
    })
  }, [projectId])

  useEffect(() => {
    void loadPage()
  }, [loadPage])

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

      <ProjectDataAccessMigration
        tenantId={tenantId}
        projectId={projectId}
        projectAlias={currentProject?.alias ?? ''}
        runtimeMode={overview?.runtimeMode ?? 'compatibility'}
        migration={migration}
        loading={loading}
        error={error}
        onRefresh={() => void refreshMigration()}
        onChanged={handleMigrationChanged}
      />

      <ProjectDataAccessOverviewPanel
        tenantId={tenantId}
        projectId={projectId}
        overview={overview}
        loading={loading}
        error={error}
        onRetry={() => void loadPage()}
      />
    </DashboardLayout>
  )
}
