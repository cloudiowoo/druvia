'use client';

import { useState, useEffect } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle, Check, Wand2 } from 'lucide-react';

interface JsonEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: unknown;
  onSave: (value: unknown) => void;
  title?: string;
}

export function JsonEditorDialog({
  open,
  onOpenChange,
  value,
  onSave,
  title = 'JSON 编辑器',
}: JsonEditorDialogProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      try {
        setCode(JSON.stringify(value, null, 2));
        setError(null);
      } catch {
        setCode(String(value));
      }
    }
  }, [open, value]);

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(code);
      setCode(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleSave = () => {
    try {
      const parsed = JSON.parse(code);
      onSave(parsed);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 实时验证
  const handleChange = (newCode: string) => {
    setCode(newCode);
    try {
      JSON.parse(newCode);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {error ? (
                <span className="text-sm text-destructive flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </span>
              ) : (
                <span className="text-sm text-green-600 flex items-center gap-1">
                  <Check className="h-4 w-4" />
                  有效的 JSON
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handleFormat}>
              <Wand2 className="h-4 w-4 mr-2" />
              格式化
            </Button>
          </div>

          <div className="border rounded-lg overflow-hidden">
            <CodeMirror
              value={code}
              height="400px"
              extensions={[json()]}
              onChange={handleChange}
              theme="light"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!!error}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
