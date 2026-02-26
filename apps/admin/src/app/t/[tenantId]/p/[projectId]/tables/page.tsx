'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Plus } from 'lucide-react';
import { CreateTableDialog } from '@/components/CreateTableDialog';

interface TableInfo {
  tableName: string;
  rowCount: number;
  sizeBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function TablesPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentProject, currentTenant } = useAppStore();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTables = async () => {
    if (!currentProject?.schemaName) return;
    const res = await api.listTables(currentProject.schemaName);
    if (res.success && res.data) {
      setTables(res.data);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchTables();
  }, [currentProject?.schemaName]);

  return (
    <DashboardLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
            <Link href={`/t/${tenantId}`} className="hover:text-foreground">
              {currentTenant?.name}
            </Link>
            <span>/</span>
            <Link
              href={`/t/${tenantId}/p/${projectId}`}
              className="hover:text-foreground"
            >
              {currentProject?.name}
            </Link>
            <span>/</span>
            <span>数据表</span>
          </div>
          <h1 className="text-2xl font-bold">数据表</h1>
        </div>
        {currentProject?.schemaName && (
          <CreateTableDialog
            schemaName={currentProject.schemaName}
            onSuccess={fetchTables}
          />
        )}
      </div>

      <div className="border rounded-lg">
        {loading ? (
          <div className="p-4 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : tables.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-muted-foreground mb-4">暂无数据表</p>
            {currentProject?.schemaName && (
              <CreateTableDialog
                schemaName={currentProject.schemaName}
                onSuccess={fetchTables}
                trigger={
                  <Button>
                    <Plus className="h-4 w-4 mr-2" />
                    创建第一个表
                  </Button>
                }
              />
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>表名</TableHead>
                <TableHead className="text-right">行数</TableHead>
                <TableHead className="text-right">大小</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tables.map((table) => (
                <TableRow key={table.tableName}>
                  <TableCell className="font-medium font-mono">
                    {table.tableName}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {table.rowCount.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatBytes(table.sizeBytes)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link
                        href={`/t/${tenantId}/p/${projectId}/tables/${table.tableName}`}
                      >
                        查看
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
