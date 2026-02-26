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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface Project {
  projectId: string;
  alias: string;
  name: string;
  status: string;
}

export default function ProjectsPage() {
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

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">项目管理</h1>
          <p className="text-muted-foreground">
            {currentTenant?.name} 的所有项目
          </p>
        </div>
        <Button asChild>
          <Link href={`/t/${tenantId}/projects/new`}>创建项目</Link>
        </Button>
      </div>

      <div className="border rounded-lg">
        {loading ? (
          <div className="p-4 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : projects.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-muted-foreground mb-4">暂无项目</p>
            <Button asChild>
              <Link href={`/t/${tenantId}/projects/new`}>创建第一个项目</Link>
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>别名</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => (
                <TableRow key={project.projectId}>
                  <TableCell className="font-medium">{project.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {project.alias}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        project.status === 'active' ? 'default' : 'secondary'
                      }
                    >
                      {project.status === 'active' ? '活跃' : project.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/t/${tenantId}/p/${project.projectId}`}>
                        管理
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </DashboardLayout>
  );
}
