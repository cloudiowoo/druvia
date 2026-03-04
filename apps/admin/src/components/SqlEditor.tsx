'use client';

import { useCallback, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { format as formatSql } from 'sql-formatter';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { CompletionContext, autocompletion, type Completion } from '@codemirror/autocomplete';

export interface SchemaMetadata {
  tables: Array<{
    name: string;
    columns: Array<{
      name: string;
      type: string;
    }>;
  }>;
}

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onExecute?: () => void;
  onFormat?: () => void;
  schemaMetadata?: SchemaMetadata;
  height?: string;
  readOnly?: boolean;
  placeholder?: string;
}

export function SqlEditor({
  value,
  onChange,
  onExecute,
  schemaMetadata,
  height = '200px',
  readOnly = false,
  placeholder = '输入 SQL 查询...',
}: SqlEditorProps) {
  // 格式化 SQL
  const handleFormat = useCallback(() => {
    try {
      const formatted = formatSql(value, {
        language: 'postgresql',
        tabWidth: 2,
        keywordCase: 'upper',
      });
      onChange(formatted);
    } catch {
      // 格式化失败时保持原样
    }
  }, [value, onChange]);

  // 自定义快捷键 (使用 Prec.highest 确保优先级最高)
  const customKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onExecute?.();
              return true;
            },
            preventDefault: true,
          },
          {
            key: 'Mod-Shift-f',
            run: () => {
              handleFormat();
              return true;
            },
            preventDefault: true,
          },
        ])
      ),
    [onExecute, handleFormat]
  );

  // 自动完成：从 schema metadata 生成
  const schemaCompletion = useMemo(() => {
    if (!schemaMetadata?.tables?.length) return null;

    // 构建表名和列名的补全列表
    const tableCompletions: Completion[] = schemaMetadata.tables.map((t) => ({
      label: t.name,
      type: 'class',
      detail: 'table',
    }));

    const columnCompletions: Completion[] = schemaMetadata.tables.flatMap((t) =>
      t.columns.map((c) => ({
        label: c.name,
        type: 'property',
        detail: `${t.name}.${c.type}`,
      }))
    );

    // 表名.列名 的补全
    const qualifiedCompletions: Completion[] = schemaMetadata.tables.flatMap((t) =>
      t.columns.map((c) => ({
        label: `${t.name}.${c.name}`,
        type: 'property',
        detail: c.type,
      }))
    );

    return (context: CompletionContext) => {
      const word = context.matchBefore(/[\w.]*$/);
      if (!word || (word.from === word.to && !context.explicit)) return null;

      const text = word.text;
      let options: Completion[] = [];

      if (text.includes('.')) {
        // 如果包含点，可能是 table.column
        const [tableName] = text.split('.');
        const table = schemaMetadata.tables.find(
          (t) => t.name.toLowerCase() === tableName.toLowerCase()
        );
        if (table) {
          options = table.columns.map((c) => ({
            label: `${table.name}.${c.name}`,
            type: 'property',
            detail: c.type,
          }));
        } else {
          options = qualifiedCompletions;
        }
      } else {
        // 显示表名和所有列名
        options = [...tableCompletions, ...columnCompletions];
      }

      return {
        from: word.from,
        options,
        validFor: /^[\w.]*$/,
      };
    };
  }, [schemaMetadata]);

  // 扩展配置
  const extensions = useMemo(() => {
    const exts = [
      sql({ dialect: PostgreSQL }),
      customKeymap,
    ];

    if (schemaCompletion) {
      exts.push(
        autocompletion({
          override: [schemaCompletion],
          activateOnTyping: true,
        })
      );
    }

    return exts;
  }, [customKeymap, schemaCompletion]);

  return (
    <div className="border rounded-lg overflow-hidden">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        height={height}
        placeholder={placeholder}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightActiveLine: true,
          foldGutter: true,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
          rectangularSelection: true,
          crosshairCursor: true,
          highlightSelectionMatches: true,
        }}
        theme="light"
      />
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-t text-xs text-gray-500">
        <span>PostgreSQL</span>
        <div className="flex gap-4">
          <span>
            <kbd className="px-1 py-0.5 bg-gray-200 rounded text-[10px]">⌘</kbd>
            <span className="mx-0.5">+</span>
            <kbd className="px-1 py-0.5 bg-gray-200 rounded text-[10px]">Enter</kbd>
            <span className="ml-1">执行</span>
          </span>
          <span>
            <kbd className="px-1 py-0.5 bg-gray-200 rounded text-[10px]">⌘</kbd>
            <span className="mx-0.5">+</span>
            <kbd className="px-1 py-0.5 bg-gray-200 rounded text-[10px]">⇧</kbd>
            <span className="mx-0.5">+</span>
            <kbd className="px-1 py-0.5 bg-gray-200 rounded text-[10px]">F</kbd>
            <span className="ml-1">格式化</span>
          </span>
        </div>
      </div>
    </div>
  );
}
