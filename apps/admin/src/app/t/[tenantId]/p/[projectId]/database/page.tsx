'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { SqlTabBar } from '@/components/SqlTabBar';
import { SqlImportExport } from '@/components/SqlImportExport';
import type { SchemaMetadata } from '@/components/SqlEditor';
import { Trash2, Clock, Shield, AlertTriangle } from 'lucide-react';

interface QueryHistory {
  sql: string;
  timestamp: number;
  mode: 'query' | 'ddl';
}

const HISTORY_KEY = 'druvia_sql_history';

export default function ProjectDatabasePage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentTenant, currentProject, currentEnv } = useAppStore();

  // 获取当前有效的 schema（优先使用环境 schema，否则使用项目 schema）
  const effectiveSchema = currentEnv?.schemaName || currentProject?.schemaName;

  const [history, setHistory] = useState<QueryHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [mode, setMode] = useState<'query' | 'ddl'>('query');
  const [schemaMetadata, setSchemaMetadata] = useState<SchemaMetadata | undefined>();

  // 加载查询历史
  useEffect(() => {
    const saved = localStorage.getItem(`${HISTORY_KEY}_${projectId}`);
    if (saved) {
      setHistory(JSON.parse(saved));
    }
  }, [projectId]);

  // 加载 Schema 元数据（用于自动完成）
  useEffect(() => {
    async function loadMetadata() {
      if (!effectiveSchema) return;
      const res = await api.getSchemaMetadata(effectiveSchema);
      if (res.success && res.data) {
        setSchemaMetadata(res.data);
      }
    }
    loadMetadata();
  }, [currentProject?.schemaName]);

  const saveHistory = useCallback((sql: string, queryMode: 'query' | 'ddl') => {
    const newHistory = [
      { sql: sql.trim(), timestamp: Date.now(), mode: queryMode },
      ...history.filter(h => h.sql !== sql.trim()).slice(0, 19),
    ];
    setHistory(newHistory);
    localStorage.setItem(`${HISTORY_KEY}_${projectId}`, JSON.stringify(newHistory));
  }, [history, projectId]);

  const clearHistory = () => {
    setHistory([]);
    localStorage.setItem(`${HISTORY_KEY}_${projectId}`, JSON.stringify([]));
  };

  const handleExecute = useCallback(async (sql: string, queryMode: 'query' | 'ddl') => {
    const res = queryMode === 'ddl'
      ? await api.executeDdl(projectId, sql)
      : await api.executeQuery(projectId, sql);

    if (res.success) {
      saveHistory(sql, queryMode);
    }

    return res;
  }, [projectId, saveHistory]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-CN');
  };

  return (
    <DashboardLayout>
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link href={`/t/${tenantId}`} className="hover:text-foreground">
            {currentTenant?.name}
          </Link>
          <span>/</span>
          <Link href={`/t/${tenantId}/p/${projectId}`} className="hover:text-foreground">
            {currentProject?.name}
          </Link>
          <span>/</span>
          <span>数据库</span>
        </div>
        <h1 className="text-2xl font-bold">SQL 编辑器</h1>
        <div className="flex items-center justify-between">
          <p className="text-gray-500">
            Schema: <span className="font-mono">{currentProject?.schemaName}</span>
          </p>
          <SqlImportExport
            projectId={projectId}
            onImportComplete={() => {
              // 刷新 schema metadata
              if (effectiveSchema) {
                api.getSchemaMetadata(effectiveSchema).then(res => {
                  if (res.success && res.data) {
                    setSchemaMetadata(res.data);
                  }
                });
              }
            }}
          />
        </div>
      </div>

      {/* 模式切换 + 历史按钮 */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex rounded-lg border overflow-hidden">
            <button
              onClick={() => setMode('query')}
              className={`px-4 py-2 text-sm flex items-center gap-2 ${
                mode === 'query'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Shield className="h-4 w-4" />
              只读查询
            </button>
            <button
              onClick={() => setMode('ddl')}
              className={`px-4 py-2 text-sm flex items-center gap-2 ${
                mode === 'ddl'
                  ? 'bg-orange-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              <AlertTriangle className="h-4 w-4" />
              DDL/DML
            </button>
          </div>
          {mode === 'ddl' && (
            <span className="text-sm text-orange-600 flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" />
              DDL 模式可执行 CREATE/ALTER/DROP/INSERT/UPDATE/DELETE
            </span>
          )}
        </div>

        <button
          onClick={() => setShowHistory(!showHistory)}
          className="btn btn-sm flex items-center gap-1"
        >
          <Clock className="h-4 w-4" />
          历史 {history.length > 0 && `(${history.length})`}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* SQL 编辑器（多标签） */}
        <div className={`${showHistory ? 'lg:col-span-3' : 'lg:col-span-4'}`}>
          <div className="card">
            <SqlTabBar
              projectId={projectId}
              schemaMetadata={schemaMetadata}
              onExecute={handleExecute}
              mode={mode}
            />
          </div>
        </div>

        {/* 查询历史（可折叠） */}
        {showHistory && (
          <div className="lg:col-span-1">
            <div className="card">
              <div className="card-header flex items-center justify-between">
                <h2 className="font-semibold">查询历史</h2>
                {history.length > 0 && (
                  <button
                    onClick={clearHistory}
                    className="p-1 hover:bg-gray-100 rounded"
                    title="清空历史"
                  >
                    <Trash2 className="h-4 w-4 text-gray-500" />
                  </button>
                )}
              </div>
              <div className="card-body p-0">
                {history.length === 0 ? (
                  <div className="p-4 text-center text-gray-500 text-sm">
                    暂无历史记录
                  </div>
                ) : (
                  <div className="divide-y max-h-[500px] overflow-y-auto">
                    {history.map((item, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          // 复制到剪贴板
                          navigator.clipboard.writeText(item.sql);
                        }}
                        className="w-full p-3 text-left hover:bg-gray-50 transition-colors"
                        title="点击复制"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          {item.mode === 'ddl' ? (
                            <span className="text-xs px-1.5 py-0.5 bg-orange-100 text-orange-700 rounded">DDL</span>
                          ) : (
                            <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">查询</span>
                          )}
                        </div>
                        <p className="font-mono text-xs truncate">{item.sql}</p>
                        <p className="text-xs text-gray-400 mt-1">
                          {formatDate(item.timestamp)}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
