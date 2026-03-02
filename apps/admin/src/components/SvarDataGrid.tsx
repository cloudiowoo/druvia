'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Grid, Willow } from '@svar-ui/react-grid';
import '@svar-ui/react-grid/all.css';
import { DruviaDataProvider, ColumnInfo, DataProviderOptions, FilterCondition } from '@/lib/druvia-data-provider';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { AdvancedFilter, FilterBadges } from '@/components/AdvancedFilter';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Plus,
  Trash2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ArrowUp,
  ArrowDown,
  Trash,
} from 'lucide-react';

// PostgreSQL 类型 → SVAR 编辑器映射
// SVAR 支持的编辑器类型: "text" | "combo" | "datepicker" | "richselect"
type SvarEditorType = 'text' | 'combo' | 'datepicker' | 'richselect';

// 检查是否为带时间的时间戳类型（需要时间选择器）
function isTimestampType(pgType: string): boolean {
  const timestampTypes = ['timestamp', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz'];
  return timestampTypes.includes(pgType.toLowerCase());
}

// 检查是否为纯日期类型（不含时间）
function isPureDateType(pgType: string): boolean {
  return pgType.toLowerCase() === 'date';
}

/**
 * 将 Date 对象转换为本地时间的 ISO 格式字符串
 * 避免 JSON.stringify 自动转换为 UTC 导致的时区偏移问题
 */
function dateToLocalISOString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

/**
 * 将 Date 对象转换为纯日期字符串 (YYYY-MM-DD)
 */
function dateToLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getEditor(pgType: string): SvarEditorType | undefined {
  const typeMap: Record<string, SvarEditorType> = {
    'varchar': 'text',
    'character varying': 'text',
    'text': 'text',
    'char': 'text',
    'character': 'text',
    'integer': 'text',
    'bigint': 'text',
    'smallint': 'text',
    'numeric': 'text',
    'decimal': 'text',
    'boolean': 'text',
    'date': 'datepicker',
    // timestamp 类型使用 text 编辑器，允许用户输入完整的日期时间
    'timestamp': 'text',
    'timestamp without time zone': 'text',
    'timestamp with time zone': 'text',
    'timestamptz': 'text',
  };
  const baseType = pgType.toLowerCase();
  return typeMap[baseType] || typeMap[baseType.split('(')[0]];
}

interface SvarDataGridProps {
  schemaName: string;
  tableName: string;
  primaryKeyColumn?: string;
  pageSize?: number;
  onError?: (error: Error) => void;
}

// 表结构信息（包含默认值）
interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

export function SvarDataGrid({
  schemaName,
  tableName,
  primaryKeyColumn = 'id',
  pageSize = 50,
  onError,
}: SvarDataGridProps) {
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [tableStructure, setTableStructure] = useState<TableColumn[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedRows, setSelectedRows] = useState<Record<string, unknown>[]>([]);
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [orderBy, setOrderBy] = useState<string | undefined>();
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteRowId, setDeleteRowId] = useState<unknown>(null);

  const provider = useMemo(
    () => new DruviaDataProvider(schemaName, tableName, primaryKeyColumn),
    [schemaName, tableName, primaryKeyColumn]
  );

  // 获取表结构（用于新增行时的默认值）
  const fetchTableStructure = useCallback(async () => {
    try {
      const res = await api.getTableStructure(schemaName, tableName);
      if (res.success && res.data) {
        setTableStructure(res.data.columns);
      }
    } catch (err) {
      console.error('Failed to fetch table structure:', err);
    }
  }, [schemaName, tableName]);

  useEffect(() => {
    fetchTableStructure();
  }, [fetchTableStructure]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const options: DataProviderOptions = {
        limit: pageSize,
        offset: (page - 1) * pageSize,
        orderBy,
        orderDir,
        filters: filters.length > 0 ? filters : undefined,
      };
      const result = await provider.getData(options);
      setData(result.rows);
      setColumns(result.columns);
      setTotal(result.total);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error('Load failed'));
    } finally {
      setLoading(false);
    }
  }, [provider, page, pageSize, orderBy, orderDir, filters, onError]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const totalPages = Math.ceil(total / pageSize);

  // 转换列定义为 SVAR 格式（支持排序和编辑）
  const gridColumns = useMemo(() => {
    return columns.map((col) => {
      const isPureDate = isPureDateType(col.type);
      const isTimestamp = isTimestampType(col.type);
      return {
        id: col.name,
        header: col.name,
        editor: getEditor(col.type) || 'text', // 默认使用 text 编辑器
        width: col.name === primaryKeyColumn ? 80 : undefined,
        flexgrow: col.name !== primaryKeyColumn ? 1 : undefined,
        sort: true,
        // 纯日期类型使用 datepicker，需要 template 格式化显示
        ...(isPureDate && {
          template: (v: Date | string | null) => {
            if (!v) return '';
            const date = v instanceof Date ? v : new Date(v);
            if (isNaN(date.getTime())) return String(v);
            // 显示为 YYYY-MM-DD 格式
            return dateToLocalDateString(date);
          },
        }),
        // timestamp 类型使用 text 编辑器，显示完整日期时间
        ...(isTimestamp && {
          template: (v: Date | string | null) => {
            if (!v) return '';
            const date = v instanceof Date ? v : new Date(v);
            if (isNaN(date.getTime())) return String(v);
            // 显示为 YYYY-MM-DD HH:mm:ss 格式，方便编辑
            return dateToLocalISOString(date).replace('T', ' ');
          },
        }),
      };
    });
  }, [columns, primaryKeyColumn]);

  // 将数据中的日期字符串转换为适合编辑的格式
  // - 纯日期类型：转换为 Date 对象（给 datepicker 使用）
  // - timestamp 类型：转换为本地时间字符串（给 text 编辑器使用）
  const processedData = useMemo(() => {
    const pureDateColumns = columns.filter(col => isPureDateType(col.type)).map(col => col.name);
    const timestampColumns = columns.filter(col => isTimestampType(col.type)).map(col => col.name);

    if (pureDateColumns.length === 0 && timestampColumns.length === 0) return data;

    return data.map(row => {
      const newRow = { ...row };
      // 纯日期类型转换为 Date 对象
      for (const colName of pureDateColumns) {
        const value = newRow[colName];
        if (value && typeof value === 'string') {
          const date = new Date(value);
          if (!isNaN(date.getTime())) {
            newRow[colName] = date;
          }
        }
      }
      // timestamp 类型转换为本地时间字符串（YYYY-MM-DD HH:mm:ss）
      for (const colName of timestampColumns) {
        const value = newRow[colName];
        if (value && typeof value === 'string') {
          const date = new Date(value);
          if (!isNaN(date.getTime())) {
            newRow[colName] = dateToLocalISOString(date).replace('T', ' ');
          }
        }
      }
      return newRow;
    });
  }, [data, columns]);

  // Grid 初始化 - 绑定事件处理
  const init = useCallback((api: { on: (event: string, handler: (ev: Record<string, unknown>) => void) => void }) => {
    // 监听排序事件 - SVAR Grid 使用 sort-rows 事件
    api.on('sort-rows', (ev: Record<string, unknown>) => {
      const by = ev.by as { key: string; order: string } | undefined;
      if (by?.key) {
        setOrderBy(by.key);
        setOrderDir(by.order === 'desc' ? 'desc' : 'asc');
        setPage(1);
      } else {
        setOrderBy(undefined);
        setOrderDir('asc');
      }
    });
  }, []);

  // 筛选变化
  const handleFiltersChange = (newFilters: FilterCondition[]) => {
    setFilters(newFilters);
    setPage(1);
  };

  const handleRemoveFilter = (index: number) => {
    setFilters(filters.filter((_, i) => i !== index));
    setPage(1);
  };

  // 新增行 - 使用表结构中的默认值
  const handleAddRow = async () => {
    try {
      // 构建新行数据，跳过有数据库默认值的列（如 id, created_at）
      const newRowData: Record<string, unknown> = {};

      for (const col of tableStructure) {
        // 跳过主键列（通常有自动生成的默认值）
        if (col.primaryKey) continue;

        // 跳过有数据库函数默认值的列（如 now(), gen_random_uuid()）
        if (col.defaultValue && /\(.*\)/.test(col.defaultValue)) continue;

        const baseType = col.type.split('(')[0].toLowerCase();

        // 对于没有默认值的列，设置合理的初始值
        if (!col.defaultValue) {
          if (['varchar', 'text', 'char', 'character varying', 'character'].includes(baseType)) {
            // 字符串类型：可空设为 null，不可空设为空字符串
            newRowData[col.name] = col.nullable ? null : '';
          } else if (['integer', 'bigint', 'smallint', 'numeric', 'decimal'].includes(baseType)) {
            // 数字类型：可空设为 null，不可空设为 0
            newRowData[col.name] = col.nullable ? null : 0;
          } else if (baseType === 'boolean') {
            // 布尔类型：可空设为 null，不可空设为 false
            newRowData[col.name] = col.nullable ? null : false;
          }
        }
      }

      // 确保至少有一个字段（后端要求非空 body）
      if (Object.keys(newRowData).length === 0) {
        // 如果所有列都有默认值，找第一个非主键列设置 null
        const firstNonPkCol = tableStructure.find(c => !c.primaryKey);
        if (firstNonPkCol) {
          newRowData[firstNonPkCol.name] = null;
        }
      }

      const newRow = await provider.handleEvent('add-row', { row: newRowData });
      if (newRow) {
        fetchData();
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error('Add failed'));
    }
  };

  // 删除单行
  const handleDeleteRow = async (id: unknown) => {
    try {
      await provider.handleEvent('delete-row', { id });
      setDeleteRowId(null);
      fetchData();
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error('Delete failed'));
    }
  };

  // 确认删除单行
  const confirmDeleteRow = (row: Record<string, unknown>) => {
    setDeleteRowId(row[primaryKeyColumn]);
  };

  // 删除选中行
  const handleDeleteSelected = async () => {
    if (selectedRows.length === 0) return;
    try {
      // 从选中行对象中提取主键值
      const ids = selectedRows.map((row) => row[primaryKeyColumn]);
      await provider.deleteRows(ids);
      setSelectedRows([]);
      setDeleteDialogOpen(false);
      fetchData();
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error('Delete failed'));
    }
  };

  if (loading && data.length === 0) {
    return <div className="p-4 text-center text-muted-foreground">加载中...</div>;
  }

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleAddRow}>
            <Plus className="h-4 w-4 mr-2" />
            新增行
          </Button>
          {selectedRows.length === 1 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => confirmDeleteRow(selectedRows[0])}
            >
              <Trash className="h-4 w-4 mr-2" />
              删除
            </Button>
          )}
          {selectedRows.length > 1 && (
            <Button size="sm" variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
              <Trash2 className="h-4 w-4 mr-2" />
              删除选中 ({selectedRows.length})
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 排序状态显示 */}
          {orderBy && (
            <div className="flex items-center gap-1 text-sm text-muted-foreground bg-muted px-2 py-1 rounded">
              <span>排序:</span>
              <span className="font-medium">{orderBy}</span>
              {orderDir === 'asc' ? (
                <ArrowUp className="h-3 w-3" />
              ) : (
                <ArrowDown className="h-3 w-3" />
              )}
              <button
                onClick={() => {
                  setOrderBy(undefined);
                  setOrderDir('asc');
                }}
                className="ml-1 hover:text-foreground"
              >
                ×
              </button>
            </div>
          )}
          <AdvancedFilter
            columns={columns}
            filters={filters}
            onFiltersChange={handleFiltersChange}
          />
          <Button size="sm" variant="outline" onClick={() => fetchData()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 筛选标签 */}
      {filters.length > 0 && (
        <FilterBadges filters={filters} onRemove={handleRemoveFilter} />
      )}

      {/* SVAR Grid with Willow Theme */}
      <Willow>
        <div style={{ height: 500 }}>
          <Grid
            data={processedData}
            columns={gridColumns}
            init={init}
            select={true}
            multiselect={true}
            autoRowHeight={false}
            onSelectRow={(ev: Record<string, unknown>) => {
              // SVAR Grid 返回 { id, toggle, range } 格式
              // id 是选中行的主键值
              const rowId = ev.id;
              if (rowId !== undefined && rowId !== null) {
                // 根据 ID 从 processedData 中查找行
                const selectedRow = processedData.find(row => row[primaryKeyColumn] === rowId);
                if (selectedRow) {
                  if (ev.toggle) {
                    // 切换选择：如果已选中则取消，否则添加
                    setSelectedRows(prev => {
                      const exists = prev.some(r => r[primaryKeyColumn] === rowId);
                      if (exists) {
                        return prev.filter(r => r[primaryKeyColumn] !== rowId);
                      }
                      return [...prev, selectedRow];
                    });
                  } else {
                    // 单选：替换当前选择
                    setSelectedRows([selectedRow]);
                  }
                }
              } else {
                // 取消选择
                setSelectedRows([]);
              }
            }}
            onUpdateCell={async (ev: Record<string, unknown>) => {
              // SVAR Grid 返回 { id, column, value } 格式
              try {
                const rowId = ev.id;
                const column = ev.column as string;
                let value = ev.value;

                // 处理日期值 - 避免时区偏移问题
                if (value instanceof Date) {
                  const colInfo = columns.find(c => c.name === column);
                  if (colInfo) {
                    if (isPureDateType(colInfo.type)) {
                      // 纯日期类型：转换为 YYYY-MM-DD
                      value = dateToLocalDateString(value);
                    } else if (isTimestampType(colInfo.type)) {
                      // 时间戳类型：转换为本地 ISO 格式
                      value = dateToLocalISOString(value);
                    }
                  }
                }

                if (rowId !== undefined && column) {
                  await provider.handleEvent('update-cell', {
                    id: rowId,
                    data: { [column]: value },
                  });
                  fetchData(); // 刷新数据
                }
              } catch (err) {
                onError?.(err instanceof Error ? err : new Error('Update failed'));
                fetchData(); // 出错时也刷新数据
              }
            }}
          />
        </div>
      </Willow>

      {/* 分页控件 */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          共 {total.toLocaleString()} 条记录
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage(1)}
            disabled={page === 1}
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage(page - 1)}
            disabled={page === 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm px-2">
            第 {page} / {totalPages || 1} 页
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage(page + 1)}
            disabled={page >= totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 删除确认对话框 - 批量删除 */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除选中的 {selectedRows.length} 条记录吗？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteSelected}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除确认对话框 - 单行删除 */}
      <AlertDialog open={deleteRowId !== null} onOpenChange={(open) => !open && setDeleteRowId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除 ID 为 {String(deleteRowId)} 的记录吗？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleDeleteRow(deleteRowId)}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
