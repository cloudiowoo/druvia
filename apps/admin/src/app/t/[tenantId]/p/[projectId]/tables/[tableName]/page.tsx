'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api, ForeignKeyDetail } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Plus, Trash2, MoreHorizontal, Save, ArrowLeft, Key, Database } from 'lucide-react';
import { Breadcrumb } from '@/components/Breadcrumb';
import { ForeignKeyPopover } from '@/components/tables/ForeignKeyPopover';
import { useToast } from '@/hooks/use-toast';
import { columnNameSchema } from '@/lib/schemas';

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
  isNew?: boolean;
  isModified?: boolean;
}

const COLUMN_TYPES = [
  { value: 'uuid', label: 'UUID' },
  { value: 'text', label: 'Text' },
  { value: 'varchar(255)', label: 'Varchar(255)' },
  { value: 'integer', label: 'Integer' },
  { value: 'bigint', label: 'BigInt' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'timestamp', label: 'Timestamp' },
  { value: 'timestamptz', label: 'Timestamp with TZ' },
  { value: 'date', label: 'Date' },
  { value: 'jsonb', label: 'JSONB' },
  { value: 'numeric', label: 'Numeric' },
  { value: 'real', label: 'Real' },
];

export default function TableStructurePage() {
  const params = useParams();
  const router = useRouter();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const tableName = params.tableName as string;
  const { currentProject, currentTenant, currentEnv } = useAppStore();
  const { toast } = useToast();

  // 获取当前有效的 schema（优先使用环境 schema，否则使用项目 schema）
  const effectiveSchema = currentEnv?.schemaName || currentProject?.schemaName;

  const [columns, setColumns] = useState<Column[]>([]);
  const [originalColumns, setOriginalColumns] = useState<Column[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [columnErrors, setColumnErrors] = useState<Record<number, string>>({});

  // 验证列名
  const validateColumnName = (index: number, name: string) => {
    if (!name) {
      setColumnErrors(prev => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      return;
    }
    const result = columnNameSchema.safeParse(name);
    if (!result.success) {
      setColumnErrors(prev => ({ ...prev, [index]: result.error.issues[0].message }));
    } else {
      setColumnErrors(prev => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
    }
  };

  // 加载表结构和外键
  useEffect(() => {
    async function fetchData() {
      if (!effectiveSchema) return;

      const [structureRes, fkRes] = await Promise.all([
        api.getTableStructure(effectiveSchema, tableName),
        api.getTableForeignKeys(effectiveSchema, tableName),
      ]);

      if (structureRes.success && structureRes.data) {
        setColumns(structureRes.data.columns);
        setOriginalColumns(structureRes.data.columns);
      }
      if (fkRes.success && fkRes.data) {
        setForeignKeys(fkRes.data);
      }
      setLoading(false);
    }
    fetchData();
  }, [currentProject?.schemaName, tableName]);

  // 获取列的外键信息
  const getColumnForeignKey = (columnName: string) => {
    return foreignKeys.find(fk => fk.fromColumn === columnName);
  };

  // 添加外键
  const handleAddForeignKey = async (config: {
    column: string;
    targetTable: string;
    targetColumn: string;
    onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  }) => {
    if (!effectiveSchema) return;

    const res = await api.addForeignKey(effectiveSchema, tableName, config);
    if (res.success) {
      // 刷新外键列表
      const fkRes = await api.getTableForeignKeys(effectiveSchema, tableName);
      if (fkRes.success && fkRes.data) {
        setForeignKeys(fkRes.data);
      }
      toast({ title: '外键添加成功' });
    } else {
      toast({ title: '外键添加失败', description: res.error?.message, variant: 'destructive' });
    }
  };

  // 删除外键
  const handleRemoveForeignKey = async (constraintName: string) => {
    if (!effectiveSchema) return;

    const res = await api.dropForeignKey(effectiveSchema, tableName, constraintName);
    if (res.success) {
      setForeignKeys(foreignKeys.filter(fk => fk.constraintName !== constraintName));
      toast({ title: '外键删除成功' });
    } else {
      toast({ title: '外键删除失败', description: res.error?.message, variant: 'destructive' });
    }
  };

  const hasChanges = JSON.stringify(columns) !== JSON.stringify(originalColumns);

  const addColumn = () => {
    setColumns([
      ...columns,
      {
        name: '',
        type: 'text',
        nullable: true,
        primaryKey: false,
        defaultValue: null,
        isNew: true,
      },
    ]);
  };

  const updateColumn = (index: number, field: keyof Column, value: string | boolean | null) => {
    const updated = [...columns];
    updated[index] = {
      ...updated[index],
      [field]: value,
      isModified: !updated[index].isNew,
    };
    setColumns(updated);
  };

  const removeColumn = (index: number) => {
    setColumns(columns.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!currentProject?.schemaName) return;
    setSaving(true);

    const addColumns = columns
      .filter((c) => c.isNew && c.name)
      .map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        defaultValue: c.defaultValue || undefined,
      }));

    const dropColumns = originalColumns
      .filter((oc) => !columns.find((c) => c.name === oc.name && !c.isNew))
      .map((c) => c.name);

    const alterColumns = columns
      .filter((c) => c.isModified && !c.isNew)
      .map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        defaultValue: c.defaultValue,
      }));

    const res = await api.updateTableStructure(effectiveSchema, tableName, {
      addColumns: addColumns.length > 0 ? addColumns : undefined,
      dropColumns: dropColumns.length > 0 ? dropColumns : undefined,
      alterColumns: alterColumns.length > 0 ? alterColumns : undefined,
    });

    if (res.success) {
      // Refresh data
      const refreshRes = await api.getTableStructure(effectiveSchema, tableName);
      if (refreshRes.success && refreshRes.data) {
        setColumns(refreshRes.data.columns);
        setOriginalColumns(refreshRes.data.columns);
      }
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!effectiveSchema) return;
    setDeleting(true);
    const res = await api.dropTable(effectiveSchema, tableName);
    if (res.success) {
      router.push(`/t/${tenantId}/p/${projectId}/tables`);
    }
    setDeleting(false);
    setDeleteDialogOpen(false);
  };

  return (
    <DashboardLayout>
      <Breadcrumb />

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild>
            <Link href={`/t/${tenantId}/p/${projectId}/tables`}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold font-mono">{tableName}</h1>
            <p className="text-muted-foreground">表结构编辑</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/t/${tenantId}/p/${projectId}/tables/${tableName}/data`}>
              <Database className="h-4 w-4 mr-2" />
              查看数据
            </Link>
          </Button>
          <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="destructive" size="sm">
                <Trash2 className="h-4 w-4 mr-2" />
                删除表
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>确认删除</DialogTitle>
                <DialogDescription>
                  确定要删除表 {tableName} 吗？此操作不可撤销，所有数据将被永久删除。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                  取消
                </Button>
                <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                  {deleting ? '删除中...' : '确认删除'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button onClick={handleSave} disabled={!hasChanges || saving}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? '保存中...' : '保存更改'}
          </Button>
        </div>
      </div>

      <div className="border rounded-lg">
        {loading ? (
          <div className="p-4 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">字段名</TableHead>
                  <TableHead className="w-[160px]">类型</TableHead>
                  <TableHead className="w-[180px]">默认值</TableHead>
                  <TableHead className="w-[80px] text-center">可空</TableHead>
                  <TableHead className="w-[80px] text-center">主键</TableHead>
                  <TableHead className="w-[80px] text-center">外键</TableHead>
                  <TableHead className="w-[60px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {columns.map((column, index) => {
                  const fk = getColumnForeignKey(column.name);
                  return (
                  <TableRow key={index} className={column.isNew ? 'bg-green-50 dark:bg-green-950' : column.isModified ? 'bg-yellow-50 dark:bg-yellow-950' : ''}>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          {column.primaryKey && (
                            <Key className="h-4 w-4 text-amber-500" />
                          )}
                          <Input
                            value={column.name}
                            onChange={(e) => {
                              const value = e.target.value.toLowerCase();
                              updateColumn(index, 'name', value);
                              if (column.isNew) {
                                validateColumnName(index, value);
                              }
                            }}
                            placeholder="column_name"
                            className={`font-mono ${columnErrors[index] ? 'border-destructive' : ''}`}
                            disabled={!column.isNew && column.primaryKey}
                          />
                          {column.isNew && (
                            <Badge variant="outline" className="text-green-600">新</Badge>
                          )}
                        </div>
                        {columnErrors[index] && (
                          <p className="text-xs text-destructive">{columnErrors[index]}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={column.type}
                        onValueChange={(value) => updateColumn(index, 'type', value)}
                        disabled={column.primaryKey}
                      >
                        <SelectTrigger className="font-mono">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {COLUMN_TYPES.map((type) => (
                            <SelectItem key={type.value} value={type.value} className="font-mono">
                              {type.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        value={column.defaultValue || ''}
                        onChange={(e) => updateColumn(index, 'defaultValue', e.target.value || null)}
                        placeholder="NULL"
                        className="font-mono"
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <input
                        type="checkbox"
                        checked={column.nullable}
                        onChange={(e) => updateColumn(index, 'nullable', e.target.checked)}
                        disabled={column.primaryKey}
                        className="h-4 w-4"
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <input
                        type="checkbox"
                        checked={column.primaryKey}
                        onChange={(e) => updateColumn(index, 'primaryKey', e.target.checked)}
                        disabled={!column.isNew}
                        className="h-4 w-4"
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      {!column.isNew && effectiveSchema && (
                        <ForeignKeyPopover
                          schemaName={effectiveSchema}
                          columnName={column.name}
                          columnType={column.type}
                          existingFk={fk ? {
                            column: fk.fromColumn,
                            targetTable: fk.toTable,
                            targetColumn: fk.toColumn,
                            onDelete: fk.onDelete as 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION',
                            onUpdate: fk.onUpdate as 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION',
                          } : undefined}
                          onAdd={handleAddForeignKey}
                          onRemove={() => fk && handleRemoveForeignKey(fk.constraintName)}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => removeColumn(index)}
                            className="text-destructive"
                            disabled={column.primaryKey}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            删除字段
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="p-4 border-t">
              <Button variant="outline" onClick={addColumn}>
                <Plus className="h-4 w-4 mr-2" />
                添加字段
              </Button>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
