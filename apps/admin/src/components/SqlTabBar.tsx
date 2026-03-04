'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, X, Plus, Edit2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SqlEditor, type SchemaMetadata } from './SqlEditor';
import { ResultPanel, type QueryResult, type QueryStatus } from './ResultPanel';

interface SqlTab {
  id: string;
  name: string;
  query: string;
  result?: QueryResult | null;
  error?: string | null;
  status: QueryStatus;
}

interface SqlTabBarProps {
  projectId: string;
  schemaMetadata?: SchemaMetadata;
  onExecute: (query: string, mode: 'query' | 'ddl') => Promise<{
    success: boolean;
    data?: QueryResult;
    error?: { message: string };
  }>;
  mode: 'query' | 'ddl';
}

const TABS_KEY = 'druvia_sql_tabs';

export function SqlTabBar({ projectId, schemaMetadata, onExecute, mode }: SqlTabBarProps) {
  // 从 localStorage 加载或初始化
  const [tabs, setTabs] = useState<SqlTab[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(`${TABS_KEY}_${projectId}`);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          // 重置所有标签状态为 idle
          return parsed.map((t: SqlTab) => ({ ...t, status: 'idle' as QueryStatus, result: null, error: null }));
        } catch {
          // ignore
        }
      }
    }
    return [{ id: '1', name: '查询 1', query: '', status: 'idle' as QueryStatus }];
  });

  const [activeTabId, setActiveTabId] = useState(() => tabs[0]?.id || '1');
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  // 持久化到 localStorage（只保存 id, name, query）
  useEffect(() => {
    const toSave = tabs.map(({ id, name, query }) => ({ id, name, query }));
    localStorage.setItem(`${TABS_KEY}_${projectId}`, JSON.stringify(toSave));
  }, [tabs, projectId]);

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  const addNewTab = useCallback(() => {
    const newId = String(Date.now());
    const newTab: SqlTab = {
      id: newId,
      name: `查询 ${tabs.length + 1}`,
      query: '',
      status: 'idle',
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(newId);
  }, [tabs]);

  const closeTab = useCallback((id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (tabs.length === 1) return; // 至少保留一个标签

    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);

    if (activeTabId === id) {
      // 切换到相邻标签
      const closedIndex = tabs.findIndex(t => t.id === id);
      const newActiveIndex = Math.min(closedIndex, newTabs.length - 1);
      setActiveTabId(newTabs[newActiveIndex].id);
    }
  }, [tabs, activeTabId]);

  const updateTabQuery = useCallback((id: string, query: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, query } : t));
  }, []);

  const startEditName = useCallback((id: string, name: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditingTabId(id);
    setEditingName(name);
  }, []);

  const finishEditName = useCallback(() => {
    if (editingTabId && editingName.trim()) {
      setTabs(prev => prev.map(t =>
        t.id === editingTabId ? { ...t, name: editingName.trim() } : t
      ));
    }
    setEditingTabId(null);
    setEditingName('');
  }, [editingTabId, editingName]);

  const executeQuery = useCallback(async () => {
    if (!activeTab?.query.trim()) return;

    // 更新状态为 running
    setTabs(prev => prev.map(t =>
      t.id === activeTab.id ? { ...t, status: 'running' as QueryStatus, result: null, error: null } : t
    ));

    const startTime = Date.now();

    try {
      const res = await onExecute(activeTab.query, mode);
      const duration = Date.now() - startTime;

      if (res.success && res.data) {
        const data = res.data;
        setTabs(prev => prev.map(t =>
          t.id === activeTab.id
            ? { ...t, result: { ...data, duration }, status: 'success' as QueryStatus, error: null }
            : t
        ));
      } else {
        setTabs(prev => prev.map(t =>
          t.id === activeTab.id
            ? { ...t, error: res.error?.message || '执行失败', status: 'error' as QueryStatus, result: null }
            : t
        ));
      }
    } catch (err) {
      setTabs(prev => prev.map(t =>
        t.id === activeTab.id
          ? { ...t, error: '网络错误', status: 'error' as QueryStatus, result: null }
          : t
      ));
    }
  }, [activeTab, onExecute, mode]);

  return (
    <div className="flex flex-col h-full">
      {/* 标签栏 */}
      <div className="flex items-center border-b bg-gray-50 overflow-x-auto">
        {tabs.map(tab => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            className={cn(
              "group relative px-4 py-2 border-r cursor-pointer flex items-center gap-2 min-w-[120px] max-w-[200px]",
              "hover:bg-gray-100 transition-colors",
              activeTabId === tab.id && "bg-white border-b-2 border-b-blue-500 -mb-px"
            )}
          >
            {/* 状态指示器 */}
            {tab.status === 'running' && (
              <Loader2 className="h-3 w-3 animate-spin text-blue-500 flex-shrink-0" />
            )}
            {tab.status === 'success' && (
              <div className="h-2 w-2 rounded-full bg-green-500 flex-shrink-0" />
            )}
            {tab.status === 'error' && (
              <div className="h-2 w-2 rounded-full bg-red-500 flex-shrink-0" />
            )}

            {/* 标签名 */}
            {editingTabId === tab.id ? (
              <input
                type="text"
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={finishEditName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') finishEditName();
                  if (e.key === 'Escape') {
                    setEditingTabId(null);
                    setEditingName('');
                  }
                }}
                className="w-full px-1 py-0.5 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="text-sm truncate flex-1"
                onDoubleClick={(e) => startEditName(tab.id, tab.name, e)}
              >
                {tab.name}
              </span>
            )}

            {/* 编辑和关闭按钮 */}
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {editingTabId !== tab.id && (
                <button
                  onClick={(e) => startEditName(tab.id, tab.name, e)}
                  className="p-0.5 hover:bg-gray-200 rounded"
                  title="重命名"
                >
                  <Edit2 className="h-3 w-3 text-gray-500" />
                </button>
              )}
              {tabs.length > 1 && (
                <button
                  onClick={(e) => closeTab(tab.id, e)}
                  className="p-0.5 hover:bg-gray-200 rounded"
                  title="关闭"
                >
                  <X className="h-3 w-3 text-gray-500 hover:text-red-500" />
                </button>
              )}
            </div>
          </div>
        ))}

        {/* 新建标签按钮 */}
        <button
          onClick={addNewTab}
          className="p-2 hover:bg-gray-100 transition-colors"
          title="新建查询"
        >
          <Plus className="h-4 w-4 text-gray-500" />
        </button>
      </div>

      {/* 编辑器区域 */}
      <div className="flex-1 min-h-0">
        {activeTab && (
          <SqlEditor
            value={activeTab.query}
            onChange={(q) => updateTabQuery(activeTab.id, q)}
            onExecute={executeQuery}
            schemaMetadata={schemaMetadata}
            height="250px"
          />
        )}
      </div>

      {/* 结果面板 */}
      {activeTab && (
        <div className="mt-4">
          <ResultPanel
            result={activeTab.result}
            status={activeTab.status}
            error={activeTab.error}
          />
        </div>
      )}
    </div>
  );
}
