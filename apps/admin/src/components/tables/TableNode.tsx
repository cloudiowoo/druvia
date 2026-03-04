'use client';

import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { KeyRound, Table2 } from 'lucide-react';

interface TableNodeData {
  name: string;
  columns: Array<{ name: string; type: string; isPrimaryKey: boolean }>;
}

export const TableNode = memo(function TableNode({ data }: { data: TableNodeData }) {
  return (
    <div className="bg-card border rounded-lg shadow-md min-w-[180px] max-w-[280px]">
      <Handle type="target" position={Position.Left} className="!bg-primary" />

      <div className="px-3 py-2 bg-primary text-primary-foreground font-medium rounded-t-lg flex items-center gap-2">
        <Table2 className="h-4 w-4" />
        <span className="truncate">{data.name}</span>
      </div>

      <div className="p-2 text-sm max-h-[200px] overflow-y-auto">
        {data.columns.map((col) => (
          <div
            key={col.name}
            className="flex items-center gap-2 py-1 px-1 hover:bg-muted rounded"
          >
            {col.isPrimaryKey ? (
              <KeyRound className="h-3 w-3 text-amber-500 flex-shrink-0" />
            ) : (
              <span className="w-3" />
            )}
            <span className="font-mono text-xs truncate flex-1">{col.name}</span>
            <span className="text-muted-foreground text-xs flex-shrink-0">
              {col.type}
            </span>
          </div>
        ))}
      </div>

      <Handle type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
});
