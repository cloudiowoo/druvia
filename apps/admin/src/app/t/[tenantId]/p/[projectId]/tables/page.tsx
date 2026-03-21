'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Plus, Table2, GitBranch, RefreshCw, Check, X, Radio } from 'lucide-react';
import { CreateTableDialog } from '@/components/CreateTableDialog';
import { ERDiagram } from '@/components/tables/ERDiagram';
import { toast } from '@/hooks/use-toast';

interface TableInfo {
  tableName: string;
  rowCount: number;
  sizeBytes: number;
}

type HasuraStatus = Record<string, { tracked: boolean; roles: string[] }>;

interface TableWithColumns {
  name: string;
  columns: Array<{ name: string; type: string; isPrimaryKey: boolean }>;
}

interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
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
  const router = useRouter();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentProject, currentTenant, currentEnv } = useAppStore();

  // 获取当前有效的 schema（优先使用环境 schema，否则使用项目 schema）
  const effectiveSchema = currentEnv?.schemaName || currentProject?.schemaName;

  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasuraStatus, setHasuraStatus] = useState<HasuraStatus>({});
  const [realtimeStatus, setRealtimeStatus] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);

  // ER diagram data
  const [tablesWithColumns, setTablesWithColumns] = useState<TableWithColumns[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKey[]>([]);
  const [erLoading, setErLoading] = useState(false);
  const [erError, setErError] = useState<string | null>(null);
  const [erLoaded, setErLoaded] = useState(false);

  const fetchTables = async () => {
    if (!effectiveSchema) return;
    const [tablesRes, statusRes, realtimeRes] = await Promise.all([
      api.listTables(effectiveSchema),
      api.getHasuraStatus(effectiveSchema),
      api.listRealtimeSubscriptions(projectId, currentEnv?.name),
    ]);
    if (tablesRes.success && tablesRes.data) {
      setTables(tablesRes.data);
    }
    if (statusRes.success && statusRes.data) {
      setHasuraStatus(statusRes.data);
    }
    if (realtimeRes.success && realtimeRes.data) {
      const rtMap: Record<string, boolean> = {};
      for (const sub of realtimeRes.data.subscriptions) {
        rtMap[sub.tableName] = sub.enabled;
      }
      setRealtimeStatus(rtMap);
    }
    setLoading(false);
  };

  const handleSyncPermissions = async () => {
    if (!effectiveSchema) return;
    setSyncing(true);
    const res = await api.trackAllTablesInHasura(effectiveSchema);
    if (res.success && res.data) {
      const d = res.data;
      const parts = [`已同步 ${d.tracked.length} 张表`];
      if (d.relationships) parts.push(`${d.relationships} 个关系`);
      if (d.untracked) parts.push(`清理 ${d.untracked} 个残留`);
      toast({ title: parts.join('，') });
      // 刷新状态
      const statusRes = await api.getHasuraStatus(effectiveSchema);
      if (statusRes.success && statusRes.data) {
        setHasuraStatus(statusRes.data);
      }
    } else {
      toast({ title: '同步失败', variant: 'destructive' });
    }
    setSyncing(false);
  };

  const fetchERData = async () => {
    if (!effectiveSchema) return;
    setErLoading(true);
    setErError(null);
    const res = await api.getSchemaRelations(effectiveSchema);
    if (res.success && res.data) {
      setTablesWithColumns(res.data.tables);
      setForeignKeys(res.data.foreignKeys);
      setErLoaded(true);
    } else {
      setErError(res.error?.message || '加载失败');
    }
    setErLoading(false);
  };

  useEffect(() => {
    fetchTables();
  }, [effectiveSchema]);

  const handleTabChange = (value: string) => {
    if (value === 'er' && !erLoaded && !erLoading) {
      fetchERData();
    }
  };

  const handleTableClick = (tableName: string) => {
    router.push(`/t/${tenantId}/p/${projectId}/tables/${tableName}`);
  };

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
        {effectiveSchema && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncPermissions}
              disabled={syncing}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? '同步中...' : '同步 GraphQL 权限'}
            </Button>
            <CreateTableDialog
              schemaName={effectiveSchema}
              onSuccess={fetchTables}
            />
          </div>
        )}
      </div>

      <Tabs defaultValue="list" onValueChange={handleTabChange}>
        <TabsList className="mb-4">
          <TabsTrigger value="list" className="flex items-center gap-2">
            <Table2 className="h-4 w-4" />
            表列表
          </TabsTrigger>
          <TabsTrigger value="er" className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            关系图
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list">
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
                {effectiveSchema && (
                  <CreateTableDialog
                    schemaName={effectiveSchema}
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
                    <TableHead className="text-center">GraphQL</TableHead>
                    <TableHead className="text-center">Realtime</TableHead>
                    <TableHead className="text-right">行数</TableHead>
                    <TableHead className="text-right">大小</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tables.map((table) => {
                    const status = hasuraStatus[table.tableName];
                    const hasUser = status?.roles.includes('user');
                    const allGood = status?.tracked && hasUser;
                    const isRealtime = realtimeStatus[table.tableName] ?? false;
                    return (
                    <TableRow key={table.tableName}>
                      <TableCell className="font-medium font-mono">
                        {table.tableName}
                      </TableCell>
                      <TableCell className="text-center">
                        {allGood ? (
                          <Check className="h-4 w-4 text-green-600 inline-block" />
                        ) : status?.tracked ? (
                          <span className="text-xs text-amber-600">部分权限</span>
                        ) : (
                          <X className="h-4 w-4 text-muted-foreground inline-block" />
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {isRealtime ? (
                          <Radio className="h-4 w-4 text-green-600 inline-block" />
                        ) : (
                          <X className="h-4 w-4 text-muted-foreground inline-block" />
                        )}
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
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </TabsContent>

        <TabsContent value="er">
          {erLoading ? (
            <div className="h-[500px] border rounded-lg flex items-center justify-center">
              <div className="text-center">
                <Skeleton className="h-8 w-8 rounded-full mx-auto mb-2" />
                <span className="text-muted-foreground">加载中...</span>
              </div>
            </div>
          ) : erError ? (
            <div className="h-[500px] border rounded-lg flex items-center justify-center">
              <div className="text-center">
                <p className="text-destructive mb-4">{erError}</p>
                <Button variant="outline" onClick={fetchERData}>
                  重试
                </Button>
              </div>
            </div>
          ) : (
            <ERDiagram
              tables={tablesWithColumns}
              foreignKeys={foreignKeys}
              onTableClick={handleTableClick}
            />
          )}
        </TabsContent>
      </Tabs>
    </DashboardLayout>
  );
}
