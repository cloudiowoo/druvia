'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Upload, Download, X, FileText, Check, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

interface SqlImportExportProps {
  projectId: string;
  onImportComplete?: () => void;
}

interface ExportTable {
  name: string;
  rowCount: number;
  selected: boolean;
}

export function SqlImportExport({ projectId, onImportComplete }: SqlImportExportProps) {
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);

  return (
    <div className="flex gap-2">
      <button
        onClick={() => setShowImport(true)}
        className="btn btn-sm flex items-center gap-1"
      >
        <Upload className="h-4 w-4" />
        导入
      </button>
      <button
        onClick={() => setShowExport(true)}
        className="btn btn-sm flex items-center gap-1"
      >
        <Download className="h-4 w-4" />
        导出
      </button>

      {showImport && (
        <ImportDialog
          projectId={projectId}
          onClose={() => setShowImport(false)}
          onComplete={() => {
            setShowImport(false);
            onImportComplete?.();
          }}
        />
      )}

      {showExport && (
        <ExportDialog
          projectId={projectId}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}

// ============================================
// 导入对话框
// ============================================

interface ImportDialogProps {
  projectId: string;
  onClose: () => void;
  onComplete: () => void;
}

function ImportDialog({ projectId, onClose, onComplete }: ImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [sqlText, setSqlText] = useState('');
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    statementsExecuted: number;
    errors: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setResult(null);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && (f.name.endsWith('.sql') || f.type === 'application/sql' || f.type === 'text/plain')) {
      setFile(f);
      setResult(null);
    }
  }, []);

  const handleImport = async () => {
    setImporting(true);
    setResult(null);

    try {
      let res;
      if (mode === 'file' && file) {
        res = await api.importSql(projectId, file);
      } else if (mode === 'text' && sqlText.trim()) {
        res = await api.importSqlText(projectId, sqlText);
      } else {
        setImporting(false);
        return;
      }

      if (res.success && res.data) {
        setResult(res.data);
        if (res.data.errors.length === 0) {
          setTimeout(() => onComplete(), 1500);
        }
      } else {
        setResult({
          statementsExecuted: 0,
          errors: [res.error?.message || '导入失败'],
        });
      }
    } catch (err) {
      setResult({
        statementsExecuted: 0,
        errors: ['网络错误'],
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Upload className="h-5 w-5" />
            导入 SQL
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-4">
          {/* 模式切换 */}
          <div className="flex rounded-lg border overflow-hidden">
            <button
              onClick={() => setMode('file')}
              className={`flex-1 px-4 py-2 text-sm ${
                mode === 'file' ? 'bg-blue-600 text-white' : 'bg-gray-50 hover:bg-gray-100'
              }`}
            >
              文件上传
            </button>
            <button
              onClick={() => setMode('text')}
              className={`flex-1 px-4 py-2 text-sm ${
                mode === 'text' ? 'bg-blue-600 text-white' : 'bg-gray-50 hover:bg-gray-100'
              }`}
            >
              粘贴 SQL
            </button>
          </div>

          {mode === 'file' ? (
            /* 文件上传区域 */
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              className={`
                border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
                transition-colors
                ${file ? 'border-green-500 bg-green-50' : 'border-gray-300 hover:border-blue-500'}
              `}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".sql,text/plain"
                onChange={handleFileChange}
                className="hidden"
              />
              {file ? (
                <div className="flex items-center justify-center gap-2 text-green-700">
                  <FileText className="h-8 w-8" />
                  <div>
                    <p className="font-medium">{file.name}</p>
                    <p className="text-sm text-green-600">
                      {(file.size / 1024).toFixed(1)} KB
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-gray-500">
                  <Upload className="h-10 w-10 mx-auto mb-2" />
                  <p>拖拽 SQL 文件到此处</p>
                  <p className="text-sm">或点击选择文件</p>
                </div>
              )}
            </div>
          ) : (
            /* SQL 文本输入 */
            <textarea
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              placeholder="粘贴 SQL 语句..."
              className="w-full h-48 p-3 border rounded-lg font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}

          {/* 结果显示 */}
          {result && (
            <div className={`p-4 rounded-lg ${
              result.errors.length === 0 ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
            }`}>
              <div className="flex items-center gap-2 mb-2">
                {result.errors.length === 0 ? (
                  <>
                    <Check className="h-5 w-5 text-green-600" />
                    <span className="font-medium text-green-700">导入成功</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="h-5 w-5 text-red-600" />
                    <span className="font-medium text-red-700">导入完成，有错误</span>
                  </>
                )}
              </div>
              <p className="text-sm text-gray-600">
                执行了 {result.statementsExecuted} 条语句
              </p>
              {result.errors.length > 0 && (
                <div className="mt-2 text-sm text-red-600 max-h-32 overflow-y-auto">
                  {result.errors.map((err, i) => (
                    <p key={i} className="truncate">{err}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50">
          <button onClick={onClose} className="btn">
            取消
          </button>
          <button
            onClick={handleImport}
            disabled={importing || (mode === 'file' ? !file : !sqlText.trim())}
            className="btn btn-primary flex items-center gap-2"
          >
            {importing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                导入中...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" />
                导入
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================
// 导出对话框
// ============================================

interface ExportDialogProps {
  projectId: string;
  onClose: () => void;
}

function ExportDialog({ projectId, onClose }: ExportDialogProps) {
  const [tables, setTables] = useState<ExportTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [includeData, setIncludeData] = useState(false);
  const [includeDrops, setIncludeDrops] = useState(false);
  const [selectAll, setSelectAll] = useState(true);
  const [exportError, setExportError] = useState<string | null>(null);

  // 加载表列表
  useEffect(() => {
    async function load() {
      const res = await api.listExportableTables(projectId);
      if (res.success && res.data) {
        setTables(res.data.map(t => ({ ...t, selected: true })));
      }
      setLoading(false);
    }
    load();
  }, [projectId]);

  const handleSelectAll = (checked: boolean) => {
    setSelectAll(checked);
    setTables(tables.map(t => ({ ...t, selected: checked })));
  };

  const handleSelectTable = (name: string, checked: boolean) => {
    const newTables = tables.map(t =>
      t.name === name ? { ...t, selected: checked } : t
    );
    setTables(newTables);
    setSelectAll(newTables.every(t => t.selected));
  };

  const handleExport = async () => {
    const selectedTables = tables.filter(t => t.selected).map(t => t.name);
    if (selectedTables.length === 0) return;

    setExporting(true);
    setExportError(null);

    try {
      const blob = await api.exportSql(projectId, {
        tables: selectAll ? undefined : selectedTables,
        includeData,
        includeDrops,
      });

      // 下载文件
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `export_${new Date().toISOString().split('T')[0]}.sql`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onClose();
    } catch (err) {
      setExportError('导出失败，请重试');
    } finally {
      setExporting(false);
    }
  };

  const selectedCount = tables.filter(t => t.selected).length;
  const totalRows = tables.filter(t => t.selected).reduce((sum, t) => sum + t.rowCount, 0);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Download className="h-5 w-5" />
            导出 SQL
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-4">
          {/* 选项 */}
          <div className="space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeData}
                onChange={(e) => setIncludeData(e.target.checked)}
                className="rounded"
              />
              <span>包含数据 (INSERT 语句)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeDrops}
                onChange={(e) => setIncludeDrops(e.target.checked)}
                className="rounded"
              />
              <span>包含 DROP 语句</span>
            </label>
          </div>

          {/* 表选择 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectAll}
                  onChange={(e) => handleSelectAll(e.target.checked)}
                  className="rounded"
                />
                <span className="font-medium">选择表</span>
              </label>
              <span className="text-sm text-gray-500">
                {selectedCount} / {tables.length} 表
                {includeData && totalRows > 0 && ` (${totalRows.toLocaleString()} 行)`}
              </span>
            </div>

            <div className="border rounded-lg max-h-48 overflow-y-auto">
              {loading ? (
                <div className="p-4 text-center text-gray-500">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                </div>
              ) : tables.length === 0 ? (
                <div className="p-4 text-center text-gray-500">
                  暂无可导出的表
                </div>
              ) : (
                tables.map(table => (
                  <label
                    key={table.name}
                    className="flex items-center justify-between px-3 py-2 hover:bg-gray-50 cursor-pointer border-b last:border-b-0"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={table.selected}
                        onChange={(e) => handleSelectTable(table.name, e.target.checked)}
                        className="rounded"
                      />
                      <span className="font-mono text-sm">{table.name}</span>
                    </div>
                    <span className="text-xs text-gray-500">
                      {table.rowCount.toLocaleString()} 行
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          {/* 导出错误 */}
          {exportError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span className="text-sm">{exportError}</span>
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t bg-gray-50">
          <button onClick={onClose} className="btn">
            取消
          </button>
          <button
            onClick={handleExport}
            disabled={exporting || selectedCount === 0}
            className="btn btn-primary flex items-center gap-2"
          >
            {exporting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                导出中...
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                导出
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
