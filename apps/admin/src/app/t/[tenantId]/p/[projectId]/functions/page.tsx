'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Code, Key, FileText, Loader2, X } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { api } from '@/lib/api';
import type { EdgeFunction, InvokeResult } from '@/lib/api';
import { FunctionList } from '@/components/functions/FunctionList';
import { FunctionEditor } from '@/components/functions/FunctionEditor';
import { FunctionLogs } from '@/components/functions/FunctionLogs';
import { SecretsManager } from '@/components/functions/SecretsManager';
import { cn } from '@/lib/utils';

type Tab = 'editor' | 'logs' | 'secrets';

export default function FunctionsPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const [functions, setFunctions] = useState<EdgeFunction[]>([]);
  const [selectedFunction, setSelectedFunction] = useState<EdgeFunction | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('editor');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [confirmDeleteFunc, setConfirmDeleteFunc] = useState<string | null>(null);

  // Load functions
  useEffect(() => {
    async function loadFunctions() {
      const res = await api.listFunctions(projectId);
      if (res.success && res.data) {
        setFunctions(res.data);
      }
      setLoading(false);
    }
    loadFunctions();
  }, [projectId]);

  // 刷新函数列表
  const refreshFunctions = useCallback(async () => {
    const res = await api.listFunctions(projectId);
    if (res.success && res.data) {
      setFunctions(res.data);
      // 如果当前选中的函数被删除，清除选择
      if (selectedFunction && !res.data.find((f) => f.id === selectedFunction.id)) {
        setSelectedFunction(null);
      }
    }
  }, [projectId, selectedFunction]);

  // Handlers
  const handleCreate = async (name: string, code: string) => {
    const res = await api.createFunction(projectId, { name, code });
    if (res.success && res.data) {
      await refreshFunctions();
      setSelectedFunction(res.data);
      setShowCreateDialog(false);
    }
    return res;
  };

  const handleSave = useCallback(async (code: string, description?: string) => {
    if (!selectedFunction) return;
    const res = await api.updateFunction(projectId, selectedFunction.name, { code, description });
    if (res.success && res.data) {
      setSelectedFunction(res.data);
      setFunctions((prev) =>
        prev.map((f) => (f.id === res.data!.id ? res.data! : f))
      );
    }
  }, [projectId, selectedFunction]);

  const handleInvoke = useCallback(async (payload?: unknown): Promise<InvokeResult | null> => {
    if (!selectedFunction) return null;
    const res = await api.invokeFunction(projectId, selectedFunction.name, payload);
    if (res.success && res.data) {
      return res.data;
    }
    return null;
  }, [projectId, selectedFunction]);

  const handleDelete = async (func: EdgeFunction) => {
    if (confirmDeleteFunc !== func.id) {
      setConfirmDeleteFunc(func.id);
      return;
    }
    setConfirmDeleteFunc(null);
    const res = await api.deleteFunction(projectId, func.name);
    if (res.success) {
      if (selectedFunction?.id === func.id) {
        setSelectedFunction(null);
      }
      await refreshFunctions();
    }
  };

  const handleToggleStatus = async (func: EdgeFunction) => {
    const newStatus = func.status === 'active' ? 'disabled' : 'active';
    const res = await api.updateFunction(projectId, func.name, { status: newStatus });
    if (res.success && res.data) {
      setFunctions((prev) =>
        prev.map((f) => (f.id === res.data!.id ? res.data! : f))
      );
      if (selectedFunction?.id === func.id) {
        setSelectedFunction(res.data);
      }
    }
  };

  if (loading) {
    return (
      <DashboardLayout isProjectLevel={true}>
        <div className="flex items-center justify-center h-96">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout isProjectLevel={true}>
      <div className="h-[calc(100vh-120px)] flex">
        {/* Left Sidebar - Function List */}
        <div className="w-64 border-r bg-white flex-shrink-0">
          <FunctionList
            functions={functions}
            selectedFunction={selectedFunction}
            onSelect={setSelectedFunction}
            onCreate={() => setShowCreateDialog(true)}
            onDelete={handleDelete}
            onToggleStatus={handleToggleStatus}
            confirmDeleteId={confirmDeleteFunc}
          />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedFunction ? (
          <>
            {/* Tabs */}
            <div className="flex border-b bg-white">
              <TabButton
                active={activeTab === 'editor'}
                onClick={() => setActiveTab('editor')}
                icon={<Code className="h-4 w-4" />}
                label="编辑器"
              />
              <TabButton
                active={activeTab === 'logs'}
                onClick={() => setActiveTab('logs')}
                icon={<FileText className="h-4 w-4" />}
                label="日志"
              />
              <TabButton
                active={activeTab === 'secrets'}
                onClick={() => setActiveTab('secrets')}
                icon={<Key className="h-4 w-4" />}
                label="Secrets"
              />
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-hidden bg-white">
              {activeTab === 'editor' && (
                <FunctionEditor
                  key={selectedFunction.id}
                  func={selectedFunction}
                  onSave={handleSave}
                  onInvoke={handleInvoke}
                />
              )}
              {activeTab === 'logs' && (
                <FunctionLogs
                  projectId={projectId}
                  functionName={selectedFunction.name}
                />
              )}
              {activeTab === 'secrets' && (
                <SecretsManager projectId={projectId} />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            <div className="text-center text-gray-500">
              <Code className="h-16 w-16 mx-auto mb-4 text-gray-300" />
              <p className="text-lg">Edge Functions</p>
              <p className="text-sm mt-1">选择或创建一个函数开始</p>
            </div>
          </div>
        )}
      </div>

      {/* Create Dialog */}
      {showCreateDialog && (
        <CreateFunctionDialog
          onClose={() => setShowCreateDialog(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
    </DashboardLayout>
  );
}

// Tab Button Component
function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
        active
          ? "border-blue-500 text-blue-600"
          : "border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// Create Function Dialog
function CreateFunctionDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, code: string) => Promise<{ success: boolean; error?: { message: string } }>;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setCreating(true);
    setError('');

    const defaultCode = `// ${name} - Edge Function
// 可使用 Deno API 和 fetch

const greeting = "Hello from ${name}!";
return { message: greeting };`;

    const res = await onCreate(name.trim(), defaultCode);
    if (!res.success) {
      setError(res.error?.message || '创建失败');
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">创建函数</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              函数名称
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
              placeholder="my-function"
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              只允许字母、数字、下划线和连字符
            </p>
          </div>

          {error && (
            <p className="mt-3 text-sm text-red-600">{error}</p>
          )}

          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="btn"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="btn btn-primary flex items-center gap-2"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              创建
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
