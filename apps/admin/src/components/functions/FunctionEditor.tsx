'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Save, Play, Loader2, ShieldAlert } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import type { EdgeFunction, InvokeResult } from '@/lib/api';
import {
  getInvokeAuthModeWarning,
  INVOKE_AUTH_MODE_OPTIONS,
  type InvokeAuthMode,
} from './invoke-auth-mode';

interface FunctionEditorProps {
  func: EdgeFunction | null;
  onSave: (code: string, description?: string, invokeAuthMode?: InvokeAuthMode) => Promise<void>;
  onInvoke: (payload?: unknown) => Promise<InvokeResult | null>;
}

export function FunctionEditor({ func, onSave, onInvoke }: FunctionEditorProps) {
  const [code, setCode] = useState(func?.code || '');
  const [description, setDescription] = useState(func?.description || '');
  const [invokeAuthMode, setInvokeAuthMode] = useState<InvokeAuthMode>(func?.invokeAuthMode || 'jwt_required');
  const [payload, setPayload] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [invoking, setInvoking] = useState(false);
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // 同步 func 变化
  useEffect(() => {
    setCode(func?.code || '');
    setDescription(func?.description || '');
    setInvokeAuthMode(func?.invokeAuthMode || 'jwt_required');
    setHasChanges(false);
    setResult(null);
  }, [func?.id]);

  const handleCodeChange = useCallback((value: string) => {
    setCode(value);
    setHasChanges(
      value !== func?.code
      || description !== (func?.description || '')
      || invokeAuthMode !== (func?.invokeAuthMode || 'jwt_required')
    );
  }, [description, func?.code, func?.description, func?.invokeAuthMode, invokeAuthMode]);

  const handleSave = useCallback(async () => {
    if (!func || saving) return;
    setSaving(true);
    try {
      await onSave(code, description, invokeAuthMode);
      setHasChanges(false);
    } finally {
      setSaving(false);
    }
  }, [func, code, description, invokeAuthMode, onSave, saving]);

  const handleInvoke = useCallback(async () => {
    if (!func || invoking) return;
    setInvoking(true);
    setResult(null);
    try {
      let parsedPayload: unknown = undefined;
      if (payload.trim()) {
        try {
          parsedPayload = JSON.parse(payload);
        } catch {
          setResult({
            success: false,
            error: { message: 'Invalid JSON payload' },
            duration: 0,
            executionId: '',
          });
          return;
        }
      }
      const res = await onInvoke(parsedPayload);
      setResult(res);
    } finally {
      setInvoking(false);
    }
  }, [func, payload, onInvoke, invoking]);

  // 快捷键
  const customKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              handleSave();
              return true;
            },
            preventDefault: true,
          },
          {
            key: 'Mod-Enter',
            run: () => {
              handleInvoke();
              return true;
            },
            preventDefault: true,
          },
        ])
      ),
    [handleSave, handleInvoke]
  );

  const extensions = useMemo(() => [
    javascript({ typescript: true }),
    customKeymap,
  ], [customKeymap]);

  const anonWarning = getInvokeAuthModeWarning(invokeAuthMode);

  if (!func) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        选择或创建一个函数开始编辑
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-gray-50">
        <div className="flex items-center gap-3">
          <h3 className="font-semibold">{func.name}</h3>
          {hasChanges && (
            <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded">
              未保存
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className="btn btn-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            保存
          </button>
          <button
            onClick={handleInvoke}
            disabled={invoking || func.status !== 'active'}
            className="btn btn-sm btn-primary flex items-center gap-1.5 disabled:opacity-50"
          >
            {invoking ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            运行
          </button>
        </div>
      </div>

      {/* Description */}
      <div className="px-4 py-2 border-b">
        <input
          type="text"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setHasChanges(
              code !== (func?.code || '')
              || e.target.value !== (func?.description || '')
              || invokeAuthMode !== (func?.invokeAuthMode || 'jwt_required')
            );
          }}
          placeholder="函数描述（可选）"
          className="w-full px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <div className="mt-3 rounded-lg border bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-gray-800">Invoke Auth Mode</p>
              <p className="text-xs text-gray-500">控制该函数是否允许项目匿名 apikey 调用。</p>
            </div>
            <select
              value={invokeAuthMode}
              onChange={(e) => {
                const nextValue = e.target.value as InvokeAuthMode;
                setInvokeAuthMode(nextValue);
                setHasChanges(
                  code !== (func?.code || '')
                  || description !== (func?.description || '')
                  || nextValue !== (func?.invokeAuthMode || 'jwt_required')
                );
              }}
              className="min-w-44 rounded border bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {INVOKE_AUTH_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {anonWarning && (
            <div className="mt-3 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <p>{anonWarning}</p>
            </div>
          )}
        </div>
      </div>

      {/* Code Editor */}
      <div className="function-editor flex-1 h-0 overflow-hidden">
        <CodeMirror
          value={code}
          onChange={handleCodeChange}
          extensions={extensions}
          height="100%"
          placeholder={`// Edge Function 示例
// 可使用 Deno API 和 fetch
// Secrets 通过 Deno.env.get('KEY') 访问

const response = await fetch('https://api.example.com/data');
const data = await response.json();
return { result: data };`}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            foldGutter: true,
          }}
          theme="light"
        />
      </div>

      {/* Payload Input & Result */}
      <div className="border-t">
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-gray-50">
          <span className="text-sm text-gray-600">Payload (JSON):</span>
          <input
            type="text"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            placeholder="{}"
            className="flex-1 px-2 py-1 text-sm font-mono border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Result Panel */}
        <div className="max-h-48 overflow-y-auto p-4">
          {result && (
            <div className={`p-3 rounded-lg ${result.success ? 'bg-green-50' : 'bg-red-50'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`font-medium text-sm ${result.success ? 'text-green-700' : 'text-red-700'}`}>
                  {result.success ? '执行成功' : '执行失败'}
                </span>
                <span className="text-xs text-gray-500">
                  {result.duration}ms
                </span>
              </div>
              <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                {result.success
                  ? JSON.stringify(result.data, null, 2)
                  : result.error?.message}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* Shortcuts hint */}
      <div className="px-4 py-1.5 bg-gray-50 border-t text-xs text-gray-500 flex gap-4">
        <span>
          <kbd className="px-1 py-0.5 bg-gray-200 rounded">⌘</kbd>+
          <kbd className="px-1 py-0.5 bg-gray-200 rounded">S</kbd> 保存
        </span>
        <span>
          <kbd className="px-1 py-0.5 bg-gray-200 rounded">⌘</kbd>+
          <kbd className="px-1 py-0.5 bg-gray-200 rounded">Enter</kbd> 运行
        </span>
      </div>
    </div>
  );
}
