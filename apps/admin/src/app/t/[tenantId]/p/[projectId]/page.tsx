'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Database, Table2, Settings, HardDrive, Shield, Code, Zap, Radio } from 'lucide-react';

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
    <DashboardLayout isProjectLevel={true}>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">
            {currentTenant?.name}
          </Link>
          <span>/</span>
          <span>{currentProject.name}</span>
        </div>
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-2xl font-bold">{currentProject.name}</h1>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1 rounded-md">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            项目级别
          </span>
        </div>
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

      <div className="space-y-6">
        {/* 数据管理 */}
        <div>
          <h2 className="text-lg font-semibold mb-3 text-gray-700">数据管理</h2>
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
              href={`/t/${tenantId}/p/${projectId}/realtime`}
              className="border rounded-lg p-6 hover:bg-muted/50 transition-colors group"
            >
              <Radio className="h-8 w-8 mb-3 text-muted-foreground group-hover:text-foreground" />
              <h3 className="font-semibold mb-1">实时功能</h3>
              <p className="text-sm text-muted-foreground">GraphQL 订阅和实时数据</p>
            </Link>
          </div>
        </div>

        {/* 功能模块 */}
        <div>
          <h2 className="text-lg font-semibold mb-3 text-gray-700">功能模块</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link
              href={`/t/${tenantId}/p/${projectId}/storage`}
              className="border rounded-lg p-6 hover:bg-muted/50 transition-colors group"
            >
              <HardDrive className="h-8 w-8 mb-3 text-muted-foreground group-hover:text-foreground" />
              <h3 className="font-semibold mb-1">存储</h3>
              <p className="text-sm text-muted-foreground">文件上传和对象存储管理</p>
            </Link>

            <Link
              href={`/t/${tenantId}/p/${projectId}/auth`}
              className="border rounded-lg p-6 hover:bg-muted/50 transition-colors group"
            >
              <Shield className="h-8 w-8 mb-3 text-muted-foreground group-hover:text-foreground" />
              <h3 className="font-semibold mb-1">认证</h3>
              <p className="text-sm text-muted-foreground">用户认证和授权管理</p>
            </Link>

            <Link
              href={`/t/${tenantId}/p/${projectId}/functions`}
              className="border rounded-lg p-6 hover:bg-muted/50 transition-colors group"
            >
              <Code className="h-8 w-8 mb-3 text-muted-foreground group-hover:text-foreground" />
              <h3 className="font-semibold mb-1">函数</h3>
              <p className="text-sm text-muted-foreground">Serverless 函数和 API</p>
            </Link>

            <Link
              href={`/t/${tenantId}/p/${projectId}/api`}
              className="border rounded-lg p-6 hover:bg-muted/50 transition-colors group"
            >
              <Zap className="h-8 w-8 mb-3 text-muted-foreground group-hover:text-foreground" />
              <h3 className="font-semibold mb-1">API</h3>
              <p className="text-sm text-muted-foreground">REST API 端点管理</p>
            </Link>
          </div>
        </div>

        {/* 项目管理 */}
        <div>
          <h2 className="text-lg font-semibold mb-3 text-gray-700">项目管理</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link
              href={`/t/${tenantId}/p/${projectId}/settings`}
              className="border rounded-lg p-6 hover:bg-muted/50 transition-colors group"
            >
              <Settings className="h-8 w-8 mb-3 text-muted-foreground group-hover:text-foreground" />
              <h3 className="font-semibold mb-1">设置</h3>
              <p className="text-sm text-muted-foreground">项目配置和 API 密钥</p>
            </Link>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
