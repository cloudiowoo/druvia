'use client';

import { useState, useEffect } from 'react';
import { RefreshCw, AlertCircle, CheckCircle, Info, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { FunctionLog } from '@/lib/api';
import { cn } from '@/lib/utils';

interface FunctionLogsProps {
  projectId: string;
  functionName: string;
}

export function FunctionLogs({ projectId, functionName }: FunctionLogsProps) {
  const [logs, setLogs] = useState<FunctionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');

  useEffect(() => {
    async function loadLogs() {
      setLoading(true);
      try {
        const res = await api.getFunctionLogs(projectId, functionName, {
          limit: 100,
          level: filter === 'all' ? undefined : filter,
        });
        if (res.success && res.data) {
          setLogs(res.data);
        }
      } finally {
        setLoading(false);
      }
    }
    loadLogs();
  }, [projectId, functionName, filter]);

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const res = await api.getFunctionLogs(projectId, functionName, {
        limit: 100,
        level: filter === 'all' ? undefined : filter,
      });
      if (res.success && res.data) {
        setLogs(res.data);
      }
    } finally {
      setLoading(false);
    }
  };

  const getLevelIcon = (level: string) => {
    switch (level) {
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      case 'warn':
        return <AlertCircle className="h-4 w-4 text-yellow-500" />;
      default:
        return <CheckCircle className="h-4 w-4 text-green-500" />;
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm">执行日志</h3>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="px-2 py-1 text-sm border rounded"
          >
            <option value="all">全部</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="p-1.5 hover:bg-gray-200 rounded transition-colors"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </button>
      </div>

      {/* Logs */}
      <div className="flex-1 overflow-y-auto">
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-500">
            <Info className="h-8 w-8 mb-2" />
            <p className="text-sm">暂无执行日志</p>
          </div>
        ) : (
          <div className="divide-y">
            {logs.map((log) => (
              <div
                key={log.id}
                className={cn(
                  "px-4 py-3 hover:bg-gray-50",
                  log.level === 'error' && "bg-red-50/50",
                  log.level === 'warn' && "bg-yellow-50/50"
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5">{getLevelIcon(log.level)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-500 font-mono">
                        {log.executionId.slice(0, 8)}
                      </span>
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        {log.durationMs && (
                          <span>{log.durationMs}ms</span>
                        )}
                        <span>{formatDate(log.createdAt)}</span>
                      </div>
                    </div>
                    <p className="text-sm mt-1 break-words">{log.message}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
