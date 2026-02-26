'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface EditableCellProps {
  value: unknown;
  columnType: string;
  onSave: (newValue: unknown) => Promise<boolean>;
  disabled?: boolean;
}

export function EditableCell({ value, columnType, onSave, disabled }: EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const displayValue = formatDisplayValue(value, columnType);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const startEditing = () => {
    if (disabled) return;
    setEditValue(formatEditValue(value));
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditValue('');
  };

  const saveValue = async () => {
    if (saving) return;

    const newValue = parseValue(editValue, columnType);

    // Skip if value hasn't changed
    if (JSON.stringify(newValue) === JSON.stringify(value)) {
      cancelEditing();
      return;
    }

    setSaving(true);
    const success = await onSave(newValue);
    setSaving(false);

    if (success) {
      setIsEditing(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveValue();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditing();
    }
  };

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={saveValue}
        disabled={saving}
        className={cn(
          'h-7 px-2 py-1 font-mono text-sm',
          saving && 'opacity-50'
        )}
      />
    );
  }

  return (
    <div
      onClick={startEditing}
      className={cn(
        'px-1 py-0.5 rounded cursor-pointer hover:bg-muted min-h-[28px] flex items-center',
        disabled && 'cursor-default hover:bg-transparent'
      )}
    >
      {value === null ? (
        <span className="text-muted-foreground italic">NULL</span>
      ) : (
        <span className="truncate">{displayValue}</span>
      )}
    </div>
  );
}

function formatDisplayValue(value: unknown, columnType: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  if (columnType.includes('timestamp') && typeof value === 'string') {
    try {
      return new Date(value).toLocaleString('zh-CN');
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatEditValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function parseValue(editValue: string, columnType: string): unknown {
  const trimmed = editValue.trim();

  // Handle empty/null
  if (trimmed === '' || trimmed.toLowerCase() === 'null') {
    return null;
  }

  // Parse based on column type
  if (columnType === 'boolean') {
    return trimmed.toLowerCase() === 'true';
  }

  if (columnType === 'integer' || columnType === 'bigint') {
    const num = parseInt(trimmed, 10);
    return isNaN(num) ? trimmed : num;
  }

  if (columnType === 'numeric' || columnType === 'real' || columnType === 'double precision') {
    const num = parseFloat(trimmed);
    return isNaN(num) ? trimmed : num;
  }

  if (columnType === 'jsonb' || columnType === 'json') {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}
