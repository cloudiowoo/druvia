'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Expand } from 'lucide-react';
import { JsonEditorDialog } from './JsonEditorDialog';

interface JsonPreviewProps {
  value: unknown;
  onChange?: (value: unknown) => void;
  maxLength?: number;
}

export function JsonPreview({ value, onChange, maxLength = 50 }: JsonPreviewProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const preview = (() => {
    try {
      const str = JSON.stringify(value);
      if (str === undefined) {
        return '';
      }
      if (str.length > maxLength) {
        return str.slice(0, maxLength) + '...';
      }
      return str;
    } catch {
      return String(value ?? '');
    }
  })();

  return (
    <div className="flex items-center gap-2">
      <code className="text-sm bg-muted px-2 py-1 rounded truncate max-w-[200px]">
        {preview}
      </code>
      {onChange && (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setDialogOpen(true)}
          >
            <Expand className="h-3 w-3" />
          </Button>
          <JsonEditorDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            value={value}
            onSave={onChange}
          />
        </>
      )}
    </div>
  );
}
