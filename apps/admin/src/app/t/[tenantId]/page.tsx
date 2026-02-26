'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Project {
  projectId: string;
  alias: string;
  name: string;
  status: string;
}

export default function TenantOverviewPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const { currentTenant } = useAppStore();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchProjects() {
      const res = await api.listProjects(tenantId);
      if (res.success && res.data) {
        setProjects(res.data);
      }
      setLoading(false);
    }
    fetchProjects();
  }, [tenantId]);

  if (!currentTenant) {
    return (
      <DashboardLayout>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{currentTenant.name}</h1>
        <p className="text-muted-foreground">租户概览</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">别名</p>
          <p className="font-medium">{currentTenant.alias}</p>
        </div>
        <div className="border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">套餐</p>
          <p className="font-medium capitalize">{currentTenant.plan}</p>
        </div>
        <div className="border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">状态</p>
          <Badge variant={currentTenant.status === 'active' ? 'default' : 'secondary'}>
            {currentTenant.status === 'active' ? '活跃' : currentTenant.status}
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
        {loading ? (
          <div className="p-4 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : projects.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">暂无项目</div>
        ) : (
          <div className="divide-y">
            {projects.map((project) => (
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
