'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Search, Table2, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TableInfo {
  tableName: string;
  rowCount: number;
}

interface TableSidebarProps {
  tables: TableInfo[];
  currentTable?: string;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function TableSidebar({
  tables,
  currentTable,
  collapsed = false,
  onCollapsedChange,
}: TableSidebarProps) {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const [search, setSearch] = useState('');

  const filteredTables = useMemo(() => {
    if (!search) return tables;
    return tables.filter(t =>
      t.tableName.toLowerCase().includes(search.toLowerCase())
    );
  }, [tables, search]);

  if (collapsed) {
    return (
      <div className="w-10 border-r bg-muted/30 flex flex-col items-center py-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onCollapsedChange?.(false)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <div className="mt-4 text-xs text-muted-foreground [writing-mode:vertical-lr]">
          {tables.length} 表
        </div>
      </div>
    );
  }

  return (
    <div className="w-56 border-r bg-muted/30 flex flex-col">
      {/* 头部 */}
      <div className="p-3 border-b flex items-center justify-between">
        <span className="text-sm font-medium">数据表</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onCollapsedChange?.(true)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </div>

      {/* 搜索框 */}
      <div className="p-2">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索表..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
      </div>

      {/* 表列表 */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {filteredTables.map((table) => (
            <Link
              key={table.tableName}
              href={`/t/${tenantId}/p/${projectId}/tables/${table.tableName}/data`}
            >
              <div
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
                  currentTable === table.tableName
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                )}
              >
                <Table2 className="h-4 w-4 flex-shrink-0" />
                <span className="truncate flex-1">{table.tableName}</span>
                <span className="text-xs opacity-60">
                  {table.rowCount.toLocaleString()}
                </span>
              </div>
            </Link>
          ))}

          {filteredTables.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-4">
              {search ? '未找到匹配的表' : '暂无数据表'}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* 底部统计 */}
      <div className="p-2 border-t text-xs text-muted-foreground text-center">
        共 {tables.length} 张表
      </div>
    </div>
  );
}
