'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DashboardLayout } from '@/components/DashboardLayout';
import { useAppStore } from '@/store';
import { api } from '@/lib/api';
import { Play, Trash2, Clock } from 'lucide-react';

interface QueryResult {
  rows: Array<Record<string, unknown>>;
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
}

interface QueryHistory {
  sql: string;
  timestamp: number;
}

const HISTORY_KEY = 'druvia_sql_history';

export default function ProjectDatabasePage() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const projectId = params.projectId as string;
  const { currentTenant, currentProject } = useAppStore();

  const [sql, setSql] = useState('SELECT * FROM your_table LIMIT 10;');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<QueryHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(`${HISTORY_KEY}_${projectId}`);
    if (saved) {
      setHistory(JSON.parse(saved));
    }
  }, [projectId]);

  const saveHistory = (newHistory: QueryHistory[]) => {
    setHistory(newHistory);
    localStorage.setItem(`${HISTORY_KEY}_${projectId}`, JSON.stringify(newHistory));
  };

  const handleExecute = async () => {
    if (!sql.trim()) return;
    setExecuting(true);
    setError(null);
    setResult(null);

    try {
      const res = await api.executeQuery(projectId, sql);
      if (res.success && res.data) {
        setResult(res.data);
        const newHistory = [
          { sql: sql.trim(), timestamp: Date.now() },
          ...history.filter(h => h.sql !== sql.trim()).slice(0, 19),
        ];
        saveHistory(newHistory);
      } else {
        setError(res.error?.message || '查询执行失败');
      }
    } catch {
      setError('网络错误');
    } finally {
      setExecuting(false);
    }
  };

  const handleHistoryClick = (item: QueryHistory) => {
    setSql(item.sql);
    setShowHistory(false);
  };

  const clearHistory = () => {
    saveHistory([]);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-CN');
  };

  const formatValue = (value: unknown): string => {
    if (value === null) return 'NULL';
    if (value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
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
        <p className="text-gray-500">
          Schema: <span className="font-mono">{currentProject?.schemaName}</span>
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* SQL 编辑器 */}
        <div className="lg:col-span-3 space-y-4">
          <div className="card">
            <div className="card-header flex items-center justify-between">
              <h2 className="font-semibold">查询</h2>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="btn btn-sm flex items-center gap-1"
                >
                  <Clock className="h-4 w-4" />
                  历史
                </button>
                <button
                  onClick={handleExecute}
                  disabled={executing || !sql.trim()}
                  className="btn btn-primary btn-sm flex items-center gap-1"
                >
                  <Play className="h-4 w-4" />
                  {executing ? '执行中...' : '执行'}
                </button>
              </div>
            </div>
            <div className="card-body">
              <textarea
                className="input w-full font-mono text-sm"
                rows={8}
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                placeholder="输入 SQL 查询..."
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    handleExecute();
                  }
                }}
              />
              <p className="text-xs text-gray-500 mt-2">
                提示：按 Cmd/Ctrl + Enter 执行查询
              </p>
            </div>
          </div>

          {/* 错误信息 */}
          {error && (
            <div className="card border-red-200 bg-red-50">
              <div className="card-body">
                <p className="text-red-600">{error}</p>
              </div>
            </div>
          )}

          {/* 查询结果 */}
          {result && (
            <div className="card">
              <div className="card-header">
                <h2 className="font-semibold">
                  结果 ({result.rowCount} 行)
                </h2>
              </div>
              <div className="overflow-x-auto">
                {result.rows.length === 0 ? (
                  <div className="p-8 text-center text-gray-500">
                    查询成功，无返回数据
                  </div>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        {result.columns.map((col) => (
                          <th key={col.name} className="font-mono text-xs">
                            {col.name}
                            <span className="text-gray-400 ml-1">({col.type})</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i}>
                          {result.columns.map((col) => (
                            <td key={col.name} className="font-mono text-sm">
                              {formatValue(row[col.name])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 查询历史 */}
        <div className={`lg:col-span-1 ${showHistory ? '' : 'hidden lg:block'}`}>
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
                <div className="divide-y max-h-96 overflow-y-auto">
                  {history.map((item, i) => (
                    <button
                      key={i}
                      onClick={() => handleHistoryClick(item)}
                      className="w-full p-3 text-left hover:bg-gray-50 transition-colors"
                    >
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
      </div>
    </DashboardLayout>
  );
}
