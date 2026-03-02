'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Trash2, FileText, LayoutTemplate } from 'lucide-react';
import { api } from '@/lib/api';
import { TABLE_TEMPLATES } from '@/lib/table-templates';

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue?: string;
}

const DEFAULT_COLUMNS: Column[] = [
  { name: 'id', type: 'uuid', nullable: false, primaryKey: true, defaultValue: 'gen_random_uuid()' },
  { name: 'created_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
  { name: 'updated_at', type: 'timestamptz', nullable: false, primaryKey: false, defaultValue: 'now()' },
];

const COLUMN_TYPES = [
  { value: 'uuid', label: 'UUID' },
  { value: 'text', label: 'Text' },
  { value: 'varchar(255)', label: 'Varchar(255)' },
  { value: 'integer', label: 'Integer' },
  { value: 'bigint', label: 'BigInt' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'timestamptz', label: 'Timestamp with TZ' },
  { value: 'jsonb', label: 'JSONB' },
];

interface CreateTableDialogProps {
  schemaName: string;
  onSuccess: () => void;
  trigger?: React.ReactNode;
}

export function CreateTableDialog({ schemaName, onSuccess, trigger }: CreateTableDialogProps) {
  const [open, setOpen] = useState(false);
  const [tableName, setTableName] = useState('');
  const [columns, setColumns] = useState<Column[]>([...DEFAULT_COLUMNS]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<'blank' | 'template'>('blank');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);

  const resetForm = () => {
    setTableName('');
    setColumns([...DEFAULT_COLUMNS]);
    setError(null);
    setCreateMode('blank');
    setSelectedTemplate(null);
  };

  const applyTemplate = (templateId: string) => {
    const template = TABLE_TEMPLATES.find(t => t.id === templateId);
    if (template) {
      setTableName(template.tableName);
      setColumns(template.columns.map(c => ({ ...c })));
      setSelectedTemplate(templateId);
    }
  };

  const addColumn = () => {
    setColumns([
      ...columns,
      { name: '', type: 'text', nullable: true, primaryKey: false },
    ]);
  };

  const updateColumn = (index: number, field: keyof Column, value: string | boolean) => {
    const updated = [...columns];
    updated[index] = { ...updated[index], [field]: value };
    setColumns(updated);
  };

  const removeColumn = (index: number) => {
    setColumns(columns.filter((_, i) => i !== index));
  };

  const handleCreate = async () => {
    if (!tableName.trim()) {
      setError('请输入表名');
      return;
    }

    if (!/^[a-z][a-z0-9_]*$/.test(tableName)) {
      setError('表名必须以小写字母开头，只能包含小写字母、数字和下划线');
      return;
    }

    const validColumns = columns.filter((c) => c.name.trim());
    if (validColumns.length === 0) {
      setError('至少需要一个字段');
      return;
    }

    setCreating(true);
    setError(null);

    const res = await api.createTable(schemaName, {
      name: tableName,
      columns: validColumns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        primaryKey: c.primaryKey,
        defaultValue: c.defaultValue,
      })),
    });

    if (res.success) {
      setOpen(false);
      resetForm();
      onSuccess();
    } else {
      setError(res.error?.message || '创建失败');
    }
    setCreating(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
      <DialogTrigger asChild>
        {trigger || (
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            新建表
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建数据表</DialogTitle>
          <DialogDescription>
            选择从模板创建或手动定义表结构
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* 创建模式选择 */}
          <div className="flex gap-2">
            <Button
              variant={createMode === 'blank' ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setCreateMode('blank');
                setSelectedTemplate(null);
                setTableName('');
                setColumns([...DEFAULT_COLUMNS]);
              }}
            >
              <FileText className="h-4 w-4 mr-2" />
              空白表
            </Button>
            <Button
              variant={createMode === 'template' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCreateMode('template')}
            >
              <LayoutTemplate className="h-4 w-4 mr-2" />
              从模板创建
            </Button>
          </div>

          {/* 模板选择 */}
          {createMode === 'template' && (
            <div className="grid grid-cols-2 gap-2">
              {TABLE_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template.id)}
                  className={`p-3 text-left border rounded-lg transition-colors ${
                    selectedTemplate === template.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <div className="font-medium text-sm">{template.name}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {template.description}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div>
            <label className="text-sm font-medium mb-2 block">表名</label>
            <Input
              value={tableName}
              onChange={(e) => setTableName(e.target.value.toLowerCase())}
              placeholder="my_table"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground mt-1">
              小写字母开头，只能包含小写字母、数字和下划线
            </p>
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">字段</label>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2 font-medium">字段名</th>
                    <th className="text-left p-2 font-medium w-[140px]">类型</th>
                    <th className="text-center p-2 font-medium w-[60px]">可空</th>
                    <th className="text-center p-2 font-medium w-[60px]">主键</th>
                    <th className="w-[40px]"></th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((column, index) => (
                    <tr key={index} className="border-t">
                      <td className="p-2">
                        <Input
                          value={column.name}
                          onChange={(e) => updateColumn(index, 'name', e.target.value.toLowerCase())}
                          placeholder="column_name"
                          className="font-mono h-8"
                        />
                      </td>
                      <td className="p-2">
                        <Select
                          value={column.type}
                          onValueChange={(value) => updateColumn(index, 'type', value)}
                        >
                          <SelectTrigger className="font-mono h-8">
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
                      </td>
                      <td className="p-2 text-center">
                        <input
                          type="checkbox"
                          checked={column.nullable}
                          onChange={(e) => updateColumn(index, 'nullable', e.target.checked)}
                          disabled={column.primaryKey}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="p-2 text-center">
                        <input
                          type="checkbox"
                          checked={column.primaryKey}
                          onChange={(e) => updateColumn(index, 'primaryKey', e.target.checked)}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="p-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => removeColumn(index)}
                          disabled={column.primaryKey && columns.filter((c) => c.primaryKey).length === 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="p-2 border-t">
                <Button variant="outline" size="sm" onClick={addColumn}>
                  <Plus className="h-4 w-4 mr-2" />
                  添加字段
                </Button>
              </div>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? '创建中...' : '创建表'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
