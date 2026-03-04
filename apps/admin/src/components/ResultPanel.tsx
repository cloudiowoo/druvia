'use client';

import { Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react';

export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
  duration?: number;
}

export type QueryStatus = 'idle' | 'running' | 'success' | 'error';

export interface ResultPanelProps {
  result?: QueryResult | null;
  status?: QueryStatus;
  error?: string | null;
}

function formatValue(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function ResultPanel({ result, status = 'idle', error }: ResultPanelProps) {
  // 状态图标
  const StatusIcon = () => {
    switch (status) {
      case 'running':
        return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
      case 'success':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'error':
        return <XCircle className="h-4 w-4 text-red-500" />;
      default:
        return null;
    }
  };

  if (status === 'idle' && !result && !error) {
    return (
      <div className="border rounded-lg p-8 text-center text-gray-500">
        <p>执行 SQL 查询查看结果</p>
      </div>
    );
  }

  if (status === 'running') {
    return (
      <div className="border rounded-lg p-8 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500 mx-auto mb-2" />
        <p className="text-gray-500">执行中...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-red-200 rounded-lg bg-red-50 p-4">
        <div className="flex items-center gap-2 text-red-600 font-medium mb-2">
          <XCircle className="h-5 w-5" />
          执行错误
        </div>
        <pre className="text-sm text-red-700 whitespace-pre-wrap font-mono">
          {error}
        </pre>
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* 结果头部 */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b">
        <div className="flex items-center gap-2">
          <StatusIcon />
          <span className="font-medium">
            结果 ({result.rowCount} 行)
          </span>
        </div>
        {result.duration !== undefined && (
          <div className="flex items-center gap-1 text-sm text-gray-500">
            <Clock className="h-3 w-3" />
            {result.duration}ms
          </div>
        )}
      </div>

      {/* 结果表格 */}
      {result.rows.length === 0 ? (
        <div className="p-8 text-center text-gray-500">
          查询成功，无返回数据
        </div>
      ) : (
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 border-b w-12">
                  #
                </th>
                {result.columns.map((col) => (
                  <th
                    key={col.name}
                    className="px-3 py-2 text-left text-xs font-medium text-gray-700 border-b"
                  >
                    <div className="font-mono">{col.name}</div>
                    <div className="text-gray-400 font-normal">{col.type}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {result.rows.map((row, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-xs text-gray-400">{i + 1}</td>
                  {result.columns.map((col) => (
                    <td
                      key={col.name}
                      className="px-3 py-2 font-mono text-sm max-w-xs truncate"
                      title={formatValue(row[col.name])}
                    >
                      {row[col.name] === null ? (
                        <span className="text-gray-400 italic">NULL</span>
                      ) : (
                        formatValue(row[col.name])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
