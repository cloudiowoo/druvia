'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { DataTable } from '@/components/DataTable';
import { AdvancedFilter, FilterCondition, FilterBadges } from '@/components/AdvancedFilter';
import { Button } from '@/components/ui/button';
import { Breadcrumb } from '@/components/Breadcrumb';
import {
  ArrowLeft,
  RefreshCw,
  Download,
  Plus,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ColumnInfo {
  name: string;
  type: string;
}

export default function DataBrowserPage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const tableName = params.tableName as string;
  const { currentProject, currentTenant } = useAppStore();

  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [orderBy, setOrderBy] = useState<string | undefined>();
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc');

  const fetchData = useCallback(async () => {
    if (!currentProject?.schemaName) return;
    setLoading(true);

    const res = await api.listRows(currentProject.schemaName, tableName, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      orderBy,
      orderDir,
      filters: filters.length > 0 ? filters : undefined,
    });

    if (res.success && res.data) {
      setRows(res.data.rows);
      setTotal(res.data.total);
      setColumns(res.data.columns);
    }
    setLoading(false);
  }, [currentProject?.schemaName, tableName, page, pageSize, orderBy, orderDir, filters]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSort = (column: string, direction: 'asc' | 'desc' | null) => {
    if (direction === null) {
      setOrderBy(undefined);
      setOrderDir('asc');
    } else {
      setOrderBy(column);
      setOrderDir(direction);
    }
    setPage(1);
  };

  const handleFiltersChange = (newFilters: FilterCondition[]) => {
    setFilters(newFilters);
    setPage(1);
  };

  const handleRemoveFilter = (index: number) => {
    const newFilters = filters.filter((_, i) => i !== index);
    setFilters(newFilters);
    setPage(1);
  };

  const handleDeleteSelected = async (selectedRows: Record<string, unknown>[]) => {
    if (!currentProject?.schemaName) return;

    // Find primary key column
    const pkColumn = columns.find(c => c.name === 'id') || columns[0];
    if (!pkColumn) return;

    const primaryKeys = selectedRows.map(row => ({ [pkColumn.name]: row[pkColumn.name] }));
    const res = await api.deleteRows(currentProject.schemaName, tableName, primaryKeys);

    if (res.success) {
      fetchData();
    }
  };

  const handleExport = async (format: 'csv' | 'json') => {
    if (!currentProject?.schemaName) return;

    try {
      const blob = await api.exportData(currentProject.schemaName, tableName, format, {
        filters: filters.length > 0 ? filters : undefined,
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${tableName}_export.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export failed:', error);
    }
  };

  return (
    <DashboardLayout>
      <Breadcrumb />

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href={`/t/${tenantId}/p/${projectId}/tables/${tableName}`}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Link href={`/t/${tenantId}`} className="hover:text-foreground">
                {currentTenant?.name}
              </Link>
              <span>/</span>
              <Link href={`/t/${tenantId}/p/${projectId}`} className="hover:text-foreground">
                {currentProject?.name}
              </Link>
              <span>/</span>
              <Link href={`/t/${tenantId}/p/${projectId}/tables`} className="hover:text-foreground">
                数据表
              </Link>
              <span>/</span>
              <span className="font-mono">{tableName}</span>
            </div>
            <h1 className="text-2xl font-bold">数据浏览</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <AdvancedFilter
            columns={columns}
            filters={filters}
            onFiltersChange={handleFiltersChange}
          />
          <Button variant="outline" size="sm" onClick={fetchData}>
            <RefreshCw className="h-4 w-4 mr-2" />
            刷新
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download className="h-4 w-4 mr-2" />
                导出
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

      {filters.length > 0 && (
        <div className="mb-4">
          <FilterBadges filters={filters} onRemove={handleRemoveFilter} />
        </div>
      )}

      <DataTable
        data={rows}
        columns={columns}
        total={total}
        page={page}
        pageSize={pageSize}
        loading={loading}
        onPageChange={setPage}
        onSort={handleSort}
        onDeleteSelected={handleDeleteSelected}
        primaryKeyColumn="id"
      />
    </DashboardLayout>
  );
}
