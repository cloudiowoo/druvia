'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Filter, Plus, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export interface FilterCondition {
  column: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is_null' | 'is_not_null';
  value?: string | number | boolean | null;
}

export interface FilterGroup {
  logic: 'and' | 'or';
  conditions: FilterCondition[];
}

interface AdvancedFilterProps {
  columns: Array<{ name: string; type: string }>;
  filters: FilterCondition[];
  onFiltersChange: (filters: FilterCondition[]) => void;
}

const OPERATORS = [
  { value: 'eq', label: '等于', needsValue: true },
  { value: 'neq', label: '不等于', needsValue: true },
  { value: 'gt', label: '大于', needsValue: true },
  { value: 'gte', label: '大于等于', needsValue: true },
  { value: 'lt', label: '小于', needsValue: true },
  { value: 'lte', label: '小于等于', needsValue: true },
  { value: 'like', label: '包含', needsValue: true },
  { value: 'ilike', label: '包含(忽略大小写)', needsValue: true },
  { value: 'is_null', label: '为空', needsValue: false },
  { value: 'is_not_null', label: '不为空', needsValue: false },
];

export function AdvancedFilter({ columns, filters, onFiltersChange }: AdvancedFilterProps) {
  const [open, setOpen] = useState(false);
  const [localFilters, setLocalFilters] = useState<FilterCondition[]>(filters);

  const addFilter = () => {
    if (columns.length === 0) return;
    setLocalFilters([
      ...localFilters,
      { column: columns[0].name, operator: 'eq', value: '' },
    ]);
  };

  const updateFilter = (index: number, field: keyof FilterCondition, value: string) => {
    const updated = [...localFilters];
    if (field === 'operator') {
      const op = OPERATORS.find((o) => o.value === value);
      updated[index] = {
        ...updated[index],
        operator: value as FilterCondition['operator'],
        value: op?.needsValue ? updated[index].value : undefined,
      };
    } else {
      updated[index] = { ...updated[index], [field]: value };
    }
    setLocalFilters(updated);
  };

  const removeFilter = (index: number) => {
    setLocalFilters(localFilters.filter((_, i) => i !== index));
  };

  const applyFilters = () => {
    // Filter out incomplete conditions
    const validFilters = localFilters.filter((f) => {
      const op = OPERATORS.find((o) => o.value === f.operator);
      if (!op?.needsValue) return true;
      return f.value !== undefined && f.value !== '';
    });
    onFiltersChange(validFilters);
    setOpen(false);
  };

  const clearFilters = () => {
    setLocalFilters([]);
    onFiltersChange([]);
    setOpen(false);
  };

  const activeFilterCount = filters.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Filter className="h-4 w-4" />
          筛选
          {activeFilterCount > 0 && (
            <Badge variant="secondary" className="ml-1 px-1.5">
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[500px] p-4" align="start">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-medium">筛选条件</h4>
            {localFilters.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                清除全部
              </Button>
            )}
          </div>

          {localFilters.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              暂无筛选条件
            </p>
          ) : (
            <div className="space-y-2">
              {localFilters.map((filter, index) => {
                const op = OPERATORS.find((o) => o.value === filter.operator);
                return (
                  <div key={index} className="flex items-center gap-2">
                    {index > 0 && (
                      <span className="text-xs text-muted-foreground w-8">AND</span>
                    )}
                    {index === 0 && <span className="w-8" />}
                    <Select
                      value={filter.column}
                      onValueChange={(v) => updateFilter(index, 'column', v)}
                    >
                      <SelectTrigger className="w-[120px] h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {columns.map((col) => (
                          <SelectItem key={col.name} value={col.name} className="font-mono">
                            {col.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={filter.operator}
                      onValueChange={(v) => updateFilter(index, 'operator', v)}
                    >
                      <SelectTrigger className="w-[140px] h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OPERATORS.map((op) => (
                          <SelectItem key={op.value} value={op.value}>
                            {op.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {op?.needsValue && (
                      <Input
                        value={String(filter.value ?? '')}
                        onChange={(e) => updateFilter(index, 'value', e.target.value)}
                        placeholder="值"
                        className="flex-1 h-8"
                      />
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => removeFilter(index)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t">
            <Button variant="outline" size="sm" onClick={addFilter}>
              <Plus className="h-4 w-4 mr-2" />
              添加条件
            </Button>
            <Button size="sm" onClick={applyFilters}>
              应用筛选
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Helper to display active filters as badges
export function FilterBadges({
  filters,
  onRemove,
}: {
  filters: FilterCondition[];
  onRemove: (index: number) => void;
}) {
  if (filters.length === 0) return null;

  const getOperatorLabel = (op: string) => {
    return OPERATORS.find((o) => o.value === op)?.label || op;
  };

  return (
    <div className="flex flex-wrap gap-2">
      {filters.map((filter, index) => (
        <Badge key={index} variant="secondary" className="gap-1 pr-1">
          <span className="font-mono">{filter.column}</span>
          <span className="text-muted-foreground">{getOperatorLabel(filter.operator)}</span>
          {filter.value !== undefined && (
            <span className="font-medium">{String(filter.value)}</span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 ml-1 hover:bg-transparent"
            onClick={() => onRemove(index)}
          >
            <X className="h-3 w-3" />
          </Button>
        </Badge>
      ))}
    </div>
  );
}
