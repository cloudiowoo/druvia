'use client';

import { useState, useCallback } from 'react';
import Papa from 'papaparse';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, CheckCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { getPublicApiBaseUrl } from '@/lib/public-env';

interface Column {
  name: string;
  type: string;
}

interface CsvImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schemaName: string;
  tableName: string;
  columns: Column[];
  onSuccess?: () => void;
}

type ImportStatus = 'idle' | 'parsing' | 'mapping' | 'importing' | 'done' | 'error';

interface ColumnMapping {
  csvColumn: string;
  tableColumn: string | null;
}

interface ImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  errors: Array<{ row: number; error: string }>;
}

export function CsvImportDialog({
  open,
  onOpenChange,
  schemaName,
  tableName,
  columns,
  onSuccess,
}: CsvImportDialogProps) {
  const [status, setStatus] = useState<ImportStatus>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [csvData, setCsvData] = useState<string[][]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [onError, setOnError] = useState<'skip' | 'abort'>('skip');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStatus('idle');
    setFile(null);
    setCsvData([]);
    setCsvHeaders([]);
    setMappings([]);
    setResult(null);
    setError(null);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (selectedFile.size > 10 * 1024 * 1024) {
      setError('文件大小不能超过 10MB');
      return;
    }

    setFile(selectedFile);
    setStatus('parsing');
    setError(null);

    Papa.parse(selectedFile, {
      complete: (results) => {
        const data = results.data as string[][];
        if (data.length === 0) {
          setError('CSV 文件为空');
          setStatus('idle');
          return;
        }

        const headers = data[0];
        const rows = data.slice(1, 11);

        setCsvHeaders(headers);
        setCsvData(rows);

        const autoMappings = headers.map((csvCol) => {
          const match = columns.find(
            (tableCol) => tableCol.name.toLowerCase() === csvCol.toLowerCase()
          );
          return {
            csvColumn: csvCol,
            tableColumn: match?.name || null,
          };
        });

        setMappings(autoMappings);
        setStatus('mapping');
      },
      error: (err) => {
        setError(`解析失败: ${err.message}`);
        setStatus('idle');
      },
    });
  }, [columns]);

  const handleImport = async () => {
    if (!file) return;

    setStatus('importing');
    setError(null);

    Papa.parse(file, {
      complete: async (results) => {
        const data = results.data as string[][];
        const dataRows = data.slice(1).filter(row => row.some(cell => cell));

        // Client-side row count validation (matches server MAX_IMPORT_ROWS)
        if (dataRows.length > 10000) {
          setError('CSV 文件行数不能超过 10,000 行');
          setStatus('error');
          return;
        }

        const rows = dataRows.map((row) => {
          const obj: Record<string, unknown> = {};
          mappings.forEach((mapping, idx) => {
            if (mapping.tableColumn) {
              obj[mapping.tableColumn] = row[idx] || null;
            }
          });
          return obj;
        });

        try {
          const response = await fetch(
            `${apiBaseUrl}/api/v1/schemas/${schemaName}/tables/${tableName}/import`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${api.getToken()}`,
              },
              body: JSON.stringify({ rows, options: { onError, batchSize: 100 } }),
            }
          );

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `导入失败 (${response.status})`);
          }

          const data = await response.json();
          if (!data.success) {
            setResult(data);
            setStatus('done');
          } else {
            setResult(data);
            setStatus('done');
            onSuccess?.();
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : '导入失败');
          setStatus('error');
        }
      },
    });
  };

  const updateMapping = (csvColumn: string, tableColumn: string | null) => {
    setMappings((prev) =>
      prev.map((m) =>
        m.csvColumn === csvColumn ? { ...m, tableColumn } : m
      )
    );
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) reset();
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>导入 CSV 到 {tableName}</DialogTitle>
        </DialogHeader>

        {status === 'idle' && (
          <div className="space-y-4">
            <Label htmlFor="csv-file">选择 CSV 文件</Label>
            <Input
              id="csv-file"
              type="file"
              accept=".csv"
              onChange={handleFileSelect}
            />
            {error && (
              <div className="flex items-center gap-2 text-red-600">
                <AlertCircle className="h-4 w-4" />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {status === 'mapping' && (
          <div className="space-y-4">
            <div>
              <h3 className="font-medium mb-2">预览数据（前 10 行）</h3>
              <div className="border rounded overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      {csvHeaders.map((header, idx) => (
                        <th key={idx} className="px-3 py-2 text-left">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvData.map((row, rowIdx) => (
                      <tr key={rowIdx} className="border-t">
                        {row.map((cell, cellIdx) => (
                          <td key={cellIdx} className="px-3 py-2">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 className="font-medium mb-2">列映射</h3>
              <div className="space-y-2">
                {mappings.map((mapping, idx) => (
                  <div key={idx} className="flex items-center gap-4">
                    <div className="flex-1">
                      <Label className="text-sm text-gray-600">
                        CSV: {mapping.csvColumn}
                      </Label>
                    </div>
                    <div className="flex-1">
                      <Select
                        value={mapping.tableColumn || '__skip__'}
                        onValueChange={(value) =>
                          updateMapping(
                            mapping.csvColumn,
                            value === '__skip__' ? null : value
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__skip__">（跳过）</SelectItem>
                          {columns.map((col) => (
                            <SelectItem key={col.name} value={col.name}>
                              {col.name} ({col.type})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <Label>错误处理</Label>
              <Select value={onError} onValueChange={(v) => setOnError(v as 'skip' | 'abort')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">跳过错误行</SelectItem>
                  <SelectItem value="abort">遇到错误中断</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {status === 'importing' && (
          <div className="flex items-center justify-center py-8">
            <div className="text-center">
              <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
              <p>正在导入...</p>
            </div>
          </div>
        )}

        {status === 'done' && result && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium">导入完成</span>
            </div>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-gray-600">成功</div>
                <div className="text-2xl font-bold">{result.imported}</div>
              </div>
              <div>
                <div className="text-gray-600">跳过</div>
                <div className="text-2xl font-bold">{result.skipped}</div>
              </div>
              <div>
                <div className="text-gray-600">错误</div>
                <div className="text-2xl font-bold">{result.errors.length}</div>
              </div>
            </div>
            {result.errors.length > 0 && (
              <div className="max-h-40 overflow-y-auto border rounded p-2 text-sm">
                {result.errors.map((err, idx) => (
                  <div key={idx} className="text-red-600">
                    行 {err.row}: {err.error}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-center gap-2 text-red-600">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          {status === 'mapping' && (
            <>
              <Button variant="outline" onClick={() => setStatus('idle')}>
                重新选择
              </Button>
              <Button onClick={handleImport}>开始导入</Button>
            </>
          )}
          {(status === 'done' || status === 'error') && (
            <Button onClick={() => handleOpenChange(false)}>关闭</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
  const apiBaseUrl = getPublicApiBaseUrl();
