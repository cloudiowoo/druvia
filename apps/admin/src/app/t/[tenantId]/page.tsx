'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api, type TenantDashboardOverviewData, type TenantDashboardProjectRowData, type TenantDashboardTimelineEntryData } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { isMultiTenantEnabled } from '@/lib/tenant-config';
import { WorkspaceHealthSummary } from '@/components/dashboard/WorkspaceHealthSummary';
import { WorkspaceActionItems } from '@/components/dashboard/WorkspaceActionItems';
import { WorkspaceMetricsRow } from '@/components/dashboard/WorkspaceMetricsRow';
import { ProjectHealthList } from '@/components/dashboard/ProjectHealthList';
import { CapabilityCoverageCard } from '@/components/dashboard/CapabilityCoverageCard';
import { ActivityTimelineCard } from '@/components/dashboard/ActivityTimelineCard';

interface LegacyProject {
  projectId: string;
  alias: string;
  name: string;
  status: string;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '暂无';
  return new Date(value).toLocaleString('zh-CN');
}

export default function TenantOverviewPage() {
  const params = useParams() as { tenantId?: string } | null;
  const tenantId = params?.tenantId ?? 'default';
  const { currentTenant } = useAppStore();
  const [legacyProjects, setLegacyProjects] = useState<LegacyProject[]>([]);
  const [overview, setOverview] = useState<TenantDashboardOverviewData | null>(null);
  const [projectRows, setProjectRows] = useState<TenantDashboardProjectRowData[]>([]);
  const [timeline, setTimeline] = useState<TenantDashboardTimelineEntryData[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [partialLoadMessages, setPartialLoadMessages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const multiTenant = isMultiTenantEnabled();

  useEffect(() => {
    let cancelled = false;

    async function fetchLegacyTenantOverview() {
      setLoadError(null);
      setPartialLoadMessages([]);
      const projectsRes = await api.listProjects(tenantId);

      if (cancelled) return;

      if (projectsRes.success && projectsRes.data) {
        setLegacyProjects(projectsRes.data);
      } else {
        setLoadError(projectsRes.error?.message || '首页加载失败');
      }
      setLoading(false);
    }

    async function fetchTenantDashboard() {
      setLoadError(null);
      setPartialLoadMessages([]);
      try {
        const [overviewRes, projectsRes, timelineRes] = await Promise.all([
          api.getTenantDashboardOverview(tenantId),
          api.getTenantDashboardProjects(tenantId),
          api.getTenantDashboardTimeline(tenantId, 10),
        ]);

        if (cancelled) return;

        const partialMessages: string[] = [];
        if (overviewRes.success && overviewRes.data) {
          setOverview(overviewRes.data);
        } else {
          setLoadError(overviewRes.error?.message || '首页加载失败');
        }
        if (projectsRes.success && projectsRes.data) {
          setProjectRows(projectsRes.data);
        } else {
          setProjectRows([]);
          partialMessages.push(projectsRes.error?.message || '项目健康加载失败');
        }
        if (timelineRes.success && timelineRes.data) {
          setTimeline(timelineRes.data);
        } else {
          setTimeline([]);
          partialMessages.push(timelineRes.error?.message || '时间线加载失败');
        }
        setPartialLoadMessages(partialMessages);
      } catch {
        if (!cancelled) {
          setLoadError('首页加载失败');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    setLoading(true);

    if (multiTenant) {
      fetchLegacyTenantOverview();
    } else {
      fetchTenantDashboard();
    }

    return () => {
      cancelled = true;
    };
  }, [tenantId, multiTenant]);

  if (loading) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      </DashboardLayout>
    );
  }

  if (multiTenant) {
    return (
      <DashboardLayout>
        <div className="mb-6">
          <h1 className="text-2xl font-bold">{currentTenant?.name}</h1>
          <p className="text-muted-foreground">租户概览</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="border rounded-lg p-4">
            <p className="text-sm text-muted-foreground">别名</p>
            <p className="font-medium">{currentTenant?.alias}</p>
          </div>
          <div className="border rounded-lg p-4">
            <p className="text-sm text-muted-foreground">套餐</p>
            <p className="font-medium capitalize">{currentTenant?.plan}</p>
          </div>
          <div className="border rounded-lg p-4">
            <p className="text-sm text-muted-foreground">状态</p>
            <Badge variant={currentTenant?.status === 'active' ? 'default' : 'secondary'}>
              {currentTenant?.status === 'active' ? '活跃' : currentTenant?.status}
            </Badge>
          </div>
        </div>

        <div className="border rounded-lg">
          <div className="flex items-center justify-between p-4 border-b">
            <h2 className="font-semibold">项目列表</h2>
            <Button asChild size="sm">
              <Link href={`/t/${tenantId}/projects/new`}>创建项目</Link>
            </Button>
          </div>
          {legacyProjects.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">暂无项目</div>
          ) : (
            <div className="divide-y">
              {legacyProjects.map((project) => (
                <Link
                  key={project.projectId}
                  href={`/t/${tenantId}/p/${project.projectId}`}
                  className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                >
                  <div>
                    <p className="font-medium">{project.name}</p>
                    <p className="text-sm text-muted-foreground">{project.alias}</p>
                  </div>
                  <Badge variant={project.status === 'active' ? 'default' : 'secondary'}>
                    {project.status === 'active' ? '活跃' : project.status}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </div>
      </DashboardLayout>
    );
  }

  if (loadError && !overview) {
    return (
      <DashboardLayout>
        <div className="rounded-xl border bg-white p-8">
          <h1 className="text-2xl font-bold">首页加载失败</h1>
          <p className="mt-3 text-sm text-muted-foreground">{loadError}</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-2xl font-bold">运营概览</h1>
            <p className="text-sm text-muted-foreground">
              {overview?.workspace.label ?? `${tenantId} workspace`} · 单租户模式
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <HeaderMetric label="项目数" value={String(overview?.metrics.totalProjects ?? 0)} />
            <HeaderMetric label="能力域" value={String(overview?.capabilities.length ?? 5)} />
            <HeaderMetric label="更新时间" value={formatDateTime(overview?.updatedAt)} />
          </div>
        </header>

        {partialLoadMessages.length > 0 ? (
          <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-medium">部分数据加载失败</p>
            <p className="mt-1">{partialLoadMessages.join('；')}</p>
          </section>
        ) : null}

        <WorkspaceHealthSummary
          score={overview?.health.score ?? 0}
          summary={overview?.health.summary ?? '正在计算健康状态。'}
          factors={overview?.health.factors ?? { availability: 0, stability: 0, risk: 0 }}
        />

        <WorkspaceActionItems items={overview?.actionItems ?? []} />
        <WorkspaceMetricsRow metrics={overview?.metrics} />

        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <ProjectHealthList tenantId={tenantId} projects={projectRows} />
          <CapabilityCoverageCard capabilities={overview?.capabilities ?? []} />
        </div>

        <ActivityTimelineCard items={timeline} />
      </div>
    </DashboardLayout>
  );
}

function HeaderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white px-3 py-2 text-right">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}
