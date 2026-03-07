'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { SvarDataGrid } from '@/components/SvarDataGrid';
import { TableSidebar } from '@/components/tables/TableSidebar';
import { Button } from '@/components/ui/button';
import { Breadcrumb } from '@/components/Breadcrumb';
import { ArrowLeft, Download, Upload } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { CsvImportDialog } from '@/components/data/CsvImportDialog';

export default function DataBrowserPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const tableName = params.tableName as string;
  const { currentProject } = useAppStore();
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [columns, setColumns] = useState<Array<{ name: string; type: string }>>([]);
  const [tables, setTables] = useState<Array<{ tableName: string; rowCount: number }>>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [gridKey, setGridKey] = useState(Date.now()); // Key to force grid refresh

  // 加载表列表
  useEffect(() => {
    if (currentProject?.schemaName) {
      api.listTables(currentProject.schemaName).then(res => {
        if (res.success && res.data) {
          setTables(res.data);
        }
      });
    }
  }, [currentProject?.schemaName]);

  // 加载表结构（用于 CSV 导入列映射）
  useEffect(() => {
    if (currentProject?.schemaName && tableName) {
      api.getTableStructure(currentProject.schemaName, tableName).then(res => {
        if (res.success && res.data) {
          setColumns(res.data.columns.map(c => ({ name: c.name, type: c.type })));
        }
      });
    }
  }, [currentProject?.schemaName, tableName]);

  const handleExport = async (format: 'csv' | 'json') => {
    if (!currentProject?.schemaName) return;

    setExporting(true);
    try {
      const blob = await api.exportData(currentProject.schemaName, tableName, format);

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${tableName}_export.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        title: '导出失败',
        description: error instanceof Error ? error.message : '未知错误',
        variant: 'destructive',
      });
    } finally {
      setExporting(false);
    }
  };

  const handleError = (error: Error) => {
    toast({
      title: '操作失败',
      description: error.message,
      variant: 'destructive',
    });
  };

  if (!currentProject?.schemaName) {
    return (
      <DashboardLayout>
        <div className="p-4 text-center text-muted-foreground">加载中...</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="flex h-[calc(100vh-64px)]">
        <TableSidebar
          tables={tables}
          currentTable={tableName}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
        />
        <div className="flex-1 overflow-auto p-6">
          <Breadcrumb />

          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" asChild>
                <Link href={`/t/${tenantId}/p/${projectId}/tables/${tableName}`}>
                  <ArrowLeft className="h-4 w-4" />
                </Link>
              </Button>
              <h1 className="text-2xl font-bold">数据浏览</h1>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4 mr-2" />
                导入 CSV
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={exporting}>
                    <Download className="h-4 w-4 mr-2" />
                    {exporting ? '导出中...' : '导出'}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => handleExport('csv')}>
                    导出为 CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport('json')}>
                    导出为 JSON
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <SvarDataGrid
            key={gridKey}
            schemaName={currentProject.schemaName}
            tableName={tableName}
            primaryKeyColumn="id"
            pageSize={50}
            onError={handleError}
          />

          <CsvImportDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            schemaName={currentProject.schemaName}
            tableName={tableName}
            columns={columns}
            onSuccess={() => {
              setGridKey(Date.now()); // Refresh grid after import
              toast({
                title: '导入成功',
                description: '数据已成功导入',
              });
            }}
          />
        </div>
      </div>
    </DashboardLayout>
  );
}
