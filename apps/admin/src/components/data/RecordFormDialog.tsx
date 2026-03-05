'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { FieldRenderer } from './FieldRenderer';
import { ForeignKeySelect } from './ForeignKeySelect';
import { ForeignKeyDetail } from '@/lib/api';

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

interface RecordFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schemaName: string;
  tableName: string;
  columns: Column[];
  foreignKeys: ForeignKeyDetail[];
  record?: Record<string, unknown>;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  mode: 'create' | 'edit';
}

export function RecordFormDialog({
  open,
  onOpenChange,
  schemaName,
  tableName,
  columns,
  foreignKeys,
  record,
  onSave,
  mode,
}: RecordFormDialogProps) {
  // 动态构建 zod schema
  const schema = z.object(
    Object.fromEntries(
      columns.map(col => {
        let fieldSchema: z.ZodTypeAny = z.unknown();
        if (!col.nullable && !col.primaryKey) {
          fieldSchema = fieldSchema.refine(v => v !== null && v !== undefined && v !== '', {
            message: `${col.name} 不能为空`,
          });
        }
        return [col.name, fieldSchema];
      })
    )
  );

  const form = useForm<Record<string, unknown>>({
    resolver: zodResolver(schema),
    defaultValues: record || {},
  });

  useEffect(() => {
    if (record) {
      form.reset(record);
    } else {
      form.reset({});
    }
  }, [record, form]);

  const handleSubmit = async (data: Record<string, unknown>) => {
    await onSave(data);
    onOpenChange(false);
  };

  // 获取列的外键配置
  const getForeignKey = (columnName: string) => {
    return foreignKeys.find(fk => fk.fromColumn === columnName);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '新增记录' : '编辑记录'}</DialogTitle>
          <DialogDescription>
            {tableName} 表
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          {columns.map(col => {
            const fk = getForeignKey(col.name);
            const isPk = col.primaryKey;

            return (
              <div key={col.name} className="space-y-2">
                <Label htmlFor={col.name} className="flex items-center gap-2">
                  {col.name}
                  <span className="text-xs text-muted-foreground">({col.type})</span>
                  {!col.nullable && <span className="text-destructive">*</span>}
                </Label>

                {fk ? (
                  <ForeignKeySelect
                    name={col.name}
                    schemaName={schemaName}
                    targetTable={fk.toTable}
                    targetColumn={fk.toColumn}
                    control={form.control}
                    disabled={isPk && mode === 'edit'}
                  />
                ) : (
                  <FieldRenderer
                    name={col.name}
                    type={col.type}
                    nullable={col.nullable}
                    control={form.control}
                    disabled={isPk && mode === 'edit'}
                  />
                )}

                {form.formState.errors[col.name] && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors[col.name]?.message as string}
                  </p>
                )}
              </div>
            );
          })}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
