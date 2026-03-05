'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Link2, Plus, X } from 'lucide-react';
import { api } from '@/lib/api';

interface ForeignKeyConfig {
  column: string;
  targetTable: string;
  targetColumn: string;
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

interface ForeignKeyPopoverProps {
  schemaName: string;
  columnName: string;
  columnType: string;
  existingFk?: ForeignKeyConfig;
  onAdd: (config: ForeignKeyConfig) => void;
  onRemove: () => void;
}

const CASCADE_OPTIONS = [
  { value: 'NO ACTION', label: 'NO ACTION' },
  { value: 'CASCADE', label: 'CASCADE' },
  { value: 'SET NULL', label: 'SET NULL' },
  { value: 'RESTRICT', label: 'RESTRICT' },
];

export function ForeignKeyPopover({
  schemaName,
  columnName,
  columnType,
  existingFk,
  onAdd,
  onRemove,
}: ForeignKeyPopoverProps) {
  const [open, setOpen] = useState(false);
  const [tables, setTables] = useState<Array<{ tableName: string }>>([]);
  const [targetTable, setTargetTable] = useState(existingFk?.targetTable || '');
  const [targetColumns, setTargetColumns] = useState<Array<{ name: string; type: string; primaryKey: boolean }>>([]);
  const [targetColumn, setTargetColumn] = useState(existingFk?.targetColumn || '');
  const [onDelete, setOnDelete] = useState<ForeignKeyConfig['onDelete']>(existingFk?.onDelete || 'NO ACTION');
  const [onUpdate, setOnUpdate] = useState<ForeignKeyConfig['onUpdate']>(existingFk?.onUpdate || 'NO ACTION');

  // 加载表列表
  useEffect(() => {
    if (open && schemaName) {
      api.listTables(schemaName).then(res => {
        if (res.success && res.data) {
          setTables(res.data);
        }
      });
    }
  }, [open, schemaName]);

  // 加载目标表的列
  useEffect(() => {
    if (targetTable && schemaName) {
      api.getTableStructure(schemaName, targetTable).then(res => {
        if (res.success && res.data) {
          // 只显示类型兼容的列或主键列
          const compatibleColumns = res.data.columns.filter(
            col => col.type.toLowerCase() === columnType.toLowerCase() || col.primaryKey
          );
          setTargetColumns(compatibleColumns);
        }
      });
    }
  }, [targetTable, schemaName, columnType]);

  const handleAdd = () => {
    if (targetTable && targetColumn) {
      onAdd({
        column: columnName,
        targetTable,
        targetColumn,
        onDelete,
        onUpdate,
      });
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={existingFk ? 'secondary' : 'ghost'}
          size="icon"
          className="h-6 w-6"
        >
          <Link2 className={`h-3 w-3 ${existingFk ? 'text-primary' : ''}`} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-medium">外键配置</h4>
            {existingFk && (
              <Button variant="ghost" size="sm" onClick={onRemove}>
                <X className="h-4 w-4 mr-1" />
                移除
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">目标表</label>
            <Select value={targetTable} onValueChange={setTargetTable}>
              <SelectTrigger>
                <SelectValue placeholder="选择表" />
              </SelectTrigger>
              <SelectContent>
                {tables.map(t => (
                  <SelectItem key={t.tableName} value={t.tableName}>
                    {t.tableName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">目标列</label>
            <Select value={targetColumn} onValueChange={setTargetColumn} disabled={!targetTable}>
              <SelectTrigger>
                <SelectValue placeholder="选择列" />
              </SelectTrigger>
              <SelectContent>
                {targetColumns.map(c => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name} ({c.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">ON DELETE</label>
              <Select value={onDelete} onValueChange={(v) => setOnDelete(v as ForeignKeyConfig['onDelete'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CASCADE_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">ON UPDATE</label>
              <Select value={onUpdate} onValueChange={(v) => setOnUpdate(v as ForeignKeyConfig['onUpdate'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CASCADE_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button onClick={handleAdd} disabled={!targetTable || !targetColumn} className="w-full">
            <Plus className="h-4 w-4 mr-2" />
            {existingFk ? '更新外键' : '添加外键'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
