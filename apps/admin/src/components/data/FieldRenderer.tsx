'use client';

import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { Control, Controller } from 'react-hook-form';
import { JsonPreview } from '@/components/editors/JsonPreview';

interface FieldRendererProps {
  name: string;
  type: string;
  nullable: boolean;
  control: Control<Record<string, unknown>>;
  disabled?: boolean;
}

export function FieldRenderer({ name, type, nullable, control, disabled }: FieldRendererProps) {
  const baseType = type.toLowerCase().split('(')[0];

  // UUID 类型
  if (baseType === 'uuid') {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <div className="flex gap-2">
            <Input {...field} value={field.value as string || ''} disabled={disabled} className="font-mono" />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => field.onChange(crypto.randomUUID())}
              disabled={disabled}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        )}
      />
    );
  }

  // 布尔类型
  if (baseType === 'boolean') {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Switch
            checked={field.value as boolean}
            onCheckedChange={field.onChange}
            disabled={disabled}
          />
        )}
      />
    );
  }

  // 数字类型
  if (['integer', 'bigint', 'smallint', 'numeric', 'decimal'].includes(baseType)) {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Input
            type="number"
            {...field}
            value={field.value as number ?? ''}
            onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)}
            disabled={disabled}
          />
        )}
      />
    );
  }

  // 日期时间类型
  if (['timestamp', 'timestamptz', 'timestamp with time zone', 'timestamp without time zone'].includes(baseType)) {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Input
            type="datetime-local"
            {...field}
            value={field.value ? String(field.value).slice(0, 16) : ''}
            disabled={disabled}
          />
        )}
      />
    );
  }

  // 日期类型
  if (baseType === 'date') {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Input
            type="date"
            {...field}
            value={field.value as string || ''}
            disabled={disabled}
          />
        )}
      />
    );
  }

  // JSONB 类型 - 使用 JSON 编辑器
  if (baseType === 'jsonb' || baseType === 'json') {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <JsonPreview
            value={field.value}
            onChange={disabled ? undefined : field.onChange}
          />
        )}
      />
    );
  }

  // 长文本类型
  if (baseType === 'text') {
    return (
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <Textarea
            {...field}
            value={field.value as string || ''}
            disabled={disabled}
          />
        )}
      />
    );
  }

  // 默认：字符串输入
  return (
    <Controller
      name={name}
      control={control}
      render={({ field }) => (
        <Input {...field} value={field.value as string || ''} disabled={disabled} />
      )}
    />
  );
}
