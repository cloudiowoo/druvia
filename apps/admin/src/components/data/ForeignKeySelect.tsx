'use client';

import { useState, useEffect } from 'react';
import { Control, Controller } from 'react-hook-form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { Search } from 'lucide-react';

interface ForeignKeySelectProps {
  name: string;
  schemaName: string;
  targetTable: string;
  targetColumn: string;
  control: Control<Record<string, unknown>>;
  disabled?: boolean;
}

const EMPTY_VALUE = '__NULL__';

export function ForeignKeySelect({
  name,
  schemaName,
  targetTable,
  targetColumn,
  control,
  disabled,
}: ForeignKeySelectProps) {
  const [options, setOptions] = useState<Array<{ value: unknown; label: string }>>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchOptions = async () => {
      setLoading(true);
      try {
        const res = await api.listRows(schemaName, targetTable, { limit: 100 });
        if (res.success && res.data) {
          setOptions(
            res.data.rows
              .filter((row: Record<string, unknown>) => row[targetColumn] != null && row[targetColumn] !== '')
              .map((row: Record<string, unknown>) => ({
                value: row[targetColumn],
                label: String(row[targetColumn]),
              }))
          );
        }
      } finally {
        setLoading(false);
      }
    };
    fetchOptions();
  }, [schemaName, targetTable, targetColumn]);

  const filteredOptions = search
    ? options.filter(opt => String(opt.label).toLowerCase().includes(search.toLowerCase()))
    : options;

  return (
    <Controller
      name={name}
      control={control}
      render={({ field }) => (
        <Select
          value={field.value ? String(field.value) : EMPTY_VALUE}
          onValueChange={(v) => field.onChange(v === EMPTY_VALUE ? null : v)}
          disabled={disabled || loading}
        >
          <SelectTrigger>
            <SelectValue placeholder={loading ? '加载中...' : `选择 ${targetTable}`} />
          </SelectTrigger>
          <SelectContent>
            <div className="p-2">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="搜索..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>
            <SelectItem value={EMPTY_VALUE}>（空）</SelectItem>
            {filteredOptions.map((opt, i) => (
              <SelectItem key={i} value={String(opt.value)}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    />
  );
}
