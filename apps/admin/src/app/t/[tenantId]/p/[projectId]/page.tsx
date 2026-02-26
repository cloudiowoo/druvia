'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Database, Table2, Settings } from 'lucide-react';

export default function ProjectOverviewPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentProject, currentTenant } = useAppStore();

  if (!currentProject) {
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
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">
            {currentTenant?.name}
          </Link>
          <span>/</span>
          <span>{currentProject.name}</span>
        </div>
        <h1 className="text-2xl font-bold">{currentProject.name}</h1>
        <p className="text-muted-foreground">项目概览</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">别名</p>
          <p className="font-medium">{currentProject.alias}</p>
        </div>
        <div className="border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Schema</p>
          <p className="font-medium font-mono text-sm">
            {currentProject.schemaName || '-'}
          </p>
        </div>
        <div className="border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">状态</p>
          <Badge
            variant={currentProject.status === 'active' ? 'default' : 'secondary'}
          >
            {currentProject.status === 'active' ? '活跃' : currentProject.status}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link
          href={`/t/${tenantId}/p/${projectId}/tables`}
          className="border rounded-lg p-6 hover:bg-muted/50 transition-colors group"
        >
          <Table2 className="h-8 w-8 mb-3 text-muted-foreground group-hover:text-foreground" />
          <h3 className="font-semibold mb-1">数据表</h3>
          <p className="text-sm text-muted-foreground">管理数据库表结构和数据</p>
        </Link>

        <Link
          href={`/t/${tenantId}/p/${projectId}/database`}
          className="border rounded-lg p-6 hover:bg-muted/50 transition-colors group"
        >
          <Database className="h-8 w-8 mb-3 text-muted-foreground group-hover:text-foreground" />
          <h3 className="font-semibold mb-1">数据库</h3>
          <p className="text-sm text-muted-foreground">SQL 编辑器和数据库工具</p>
        </Link>

        <Link
          href={`/t/${tenantId}/p/${projectId}/settings`}
          className="border rounded-lg p-6 hover:bg-muted/50 transition-colors group"
        >
          <Settings className="h-8 w-8 mb-3 text-muted-foreground group-hover:text-foreground" />
          <h3 className="font-semibold mb-1">设置</h3>
          <p className="text-sm text-muted-foreground">项目配置和 API 密钥</p>
        </Link>
      </div>
    </DashboardLayout>
  );
}
