'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, Database, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import {
  buildTableDataAccessLink,
  filterProjectDataAccessTables,
  getAnonymousAccessLabel,
  getAuthenticatedAccessLabel,
  getDataInterfaceLabel,
  getLegacyAccessLabel,
  getRealtimeAccessLabel,
  PROJECT_DATA_ACCESS_FILTERS,
  type ProjectDataAccessFilter,
  type ProjectDataAccessOverview,
  type ProjectTableDataAccessOverview,
} from '@/lib/project-data-access-overview'

interface ProjectDataAccessOverviewPanelProps {
  tenantId: string
  projectId: string
  overview: ProjectDataAccessOverview | null
  loading: boolean
  error: string | null
  onRetry: () => void
}

export function ProjectDataAccessOverviewPanel({
  tenantId,
  projectId,
  overview,
  loading,
  error,
  onRetry,
}: ProjectDataAccessOverviewPanelProps) {
  const [filter, setFilter] = useState<ProjectDataAccessFilter>('all')
  const visibleTables = useMemo(
    () => overview ? filterProjectDataAccessTables(overview.tables, filter) : [],
    [filter, overview]
  )

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center border-y bg-muted/20 text-sm text-muted-foreground">
        正在加载数据访问状态
      </div>
    )
  }

  if (error || !overview) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-4 border-y bg-muted/20 px-6 text-center">
        <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />
        <div>
          <p className="font-medium">数据访问状态加载失败</p>
          <p className="mt-1 text-sm text-muted-foreground">{error || '请稍后重试'}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />
          重试
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {overview.runtimeMode === 'compatibility' && (
        <div className="flex items-start gap-3 border-l-2 border-amber-500 bg-amber-50/70 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>当前处于兼容模式，新数据访问配置尚未用于应用请求</span>
        </div>
      )}

      <div className="grid grid-cols-2 border-y bg-muted/10 sm:grid-cols-3 xl:grid-cols-6">
        <SummaryItem label="数据表总数" value={overview.summary.totalTables} />
        <SummaryItem label="已配置" value={overview.summary.configuredTables} />
        <SummaryItem label="匿名已配置" value={overview.summary.anonymousConfiguredTables} />
        <SummaryItem label="Realtime 待授权" value={overview.summary.realtimeAccessRequiredTables} />
        <SummaryItem label="旧规则" value={overview.summary.legacyTables} />
        <SummaryItem label="需检查" value={overview.summary.reviewRequiredTables} />
      </div>

      {overview.tables.length === 0 ? (
        <EmptyProject tenantId={tenantId} projectId={projectId} />
      ) : (
        <>
          <div
            role="tablist"
            aria-label="数据访问筛选"
            className="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-md bg-muted p-1 text-muted-foreground"
          >
            {PROJECT_DATA_ACCESS_FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={filter === item.value}
                onClick={() => setFilter(item.value)}
                className={cn(
                  'h-7 whitespace-nowrap rounded px-3 text-sm font-medium transition-colors',
                  filter === item.value && 'bg-background text-foreground shadow-sm'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          {visibleTables.length === 0 ? (
            <div className="flex min-h-48 items-center justify-center border-y text-sm text-muted-foreground">
              当前筛选条件下没有数据表
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableHead>数据表</TableHead>
                    <TableHead>数据接口</TableHead>
                    <TableHead>认证用户</TableHead>
                    <TableHead>匿名读取</TableHead>
                    <TableHead>实时更新</TableHead>
                    <TableHead>旧规则</TableHead>
                    <TableHead className="w-20 text-right">配置</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleTables.map((table) => (
                    <OverviewRow
                      key={table.tableName}
                      tenantId={tenantId}
                      projectId={projectId}
                      table={table}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SummaryItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-b px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function OverviewRow({
  tenantId,
  projectId,
  table,
}: {
  tenantId: string
  projectId: string
  table: ProjectTableDataAccessOverview
}) {
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="font-mono text-sm font-medium">{table.tableName}</span>
        </div>
      </TableCell>
      <TableCell>
        <StatusBadge attention={table.dataInterface === 'not_connected'}>
          {getDataInterfaceLabel(table.dataInterface)}
        </StatusBadge>
      </TableCell>
      <TableCell>
        <StatusBadge attention={table.authenticatedAccess === 'custom'}>
          {getAuthenticatedAccessLabel(table.authenticatedAccess)}
        </StatusBadge>
      </TableCell>
      <TableCell>
        <StatusBadge attention={table.anonymousAccess === 'custom'}>
          {getAnonymousAccessLabel(table.anonymousAccess)}
        </StatusBadge>
      </TableCell>
      <TableCell>
        <StatusBadge attention={table.realtime === 'access_required'}>
          {getRealtimeAccessLabel(table.realtime)}
        </StatusBadge>
      </TableCell>
      <TableCell>
        <StatusBadge attention={table.legacyAccess.authenticated || table.legacyAccess.anonymous}>
          {getLegacyAccessLabel(table.legacyAccess)}
        </StatusBadge>
      </TableCell>
      <TableCell className="text-right">
        <Button variant="ghost" size="icon" asChild>
          <Link
            href={buildTableDataAccessLink(tenantId, projectId, table.tableName)}
            aria-label={`配置 ${table.tableName}`}
          >
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  )
}

function StatusBadge({
  attention,
  children,
}: {
  attention: boolean
  children: React.ReactNode
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'whitespace-nowrap font-normal',
        attention && 'border-amber-300 bg-amber-50 text-amber-800'
      )}
    >
      {children}
    </Badge>
  )
}

function EmptyProject({ tenantId, projectId }: { tenantId: string; projectId: string }) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-3 border-y text-center">
      <Database className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">项目中还没有可配置的数据表</p>
      <Button variant="outline" size="sm" asChild>
        <Link href={`/t/${encodeURIComponent(tenantId)}/p/${encodeURIComponent(projectId)}/tables`}>
          前往数据表
        </Link>
      </Button>
    </div>
  )
}
