'use client';

import { useCallback, useEffect, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  ConnectionLineType,
  ReactFlowProvider,
} from 'reactflow';
import dagre from '@dagrejs/dagre';
import 'reactflow/dist/style.css';

import { TableNode } from './TableNode';

interface TableInfo {
  name: string;
  columns: Array<{ name: string; type: string; isPrimaryKey: boolean }>;
}

interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

interface ERDiagramProps {
  tables: TableInfo[];
  foreignKeys: ForeignKey[];
  onTableClick?: (tableName: string) => void;
}

const nodeTypes = { tableNode: TableNode };

const NODE_WIDTH = 220;
const NODE_HEADER_HEIGHT = 40;
const NODE_ROW_HEIGHT = 28;
const NODE_PADDING = 16;

function calculateNodeHeight(columnCount: number): number {
  return NODE_HEADER_HEIGHT + Math.min(columnCount, 8) * NODE_ROW_HEIGHT + NODE_PADDING;
}

function getLayoutedElements(
  tables: TableInfo[],
  foreignKeys: ForeignKey[]
): { nodes: Node[]; edges: Edge[] } {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: 'LR', nodesep: 80, ranksep: 120 });

  // Create a set of table names for quick lookup
  const tableNames = new Set(tables.map(t => t.name));

  // Add nodes with dynamic height
  tables.forEach((table) => {
    const height = calculateNodeHeight(table.columns.length);
    dagreGraph.setNode(table.name, { width: NODE_WIDTH, height });
  });

  // Filter foreign keys to only include valid ones (both tables exist)
  const validForeignKeys = foreignKeys.filter(
    fk => tableNames.has(fk.fromTable) && tableNames.has(fk.toTable)
  );

  // Add edges
  validForeignKeys.forEach((fk) => {
    dagreGraph.setEdge(fk.fromTable, fk.toTable);
  });

  // Calculate layout
  dagre.layout(dagreGraph);

  // Create React Flow nodes
  const nodes: Node[] = tables.map((table) => {
    const nodeWithPosition = dagreGraph.node(table.name);
    const height = calculateNodeHeight(table.columns.length);
    return {
      id: table.name,
      type: 'tableNode',
      position: {
        x: nodeWithPosition.x - NODE_WIDTH / 2,
        y: nodeWithPosition.y - height / 2,
      },
      data: table,
    };
  });

  // Create React Flow edges
  const edges: Edge[] = validForeignKeys.map((fk, index) => ({
    id: `fk-${index}`,
    source: fk.fromTable,
    target: fk.toTable,
    label: `${fk.fromColumn} → ${fk.toColumn}`,
    type: 'smoothstep',
    animated: true,
    style: { stroke: 'hsl(var(--primary))' },
    labelStyle: { fontSize: 10, fill: 'hsl(var(--muted-foreground))' },
  }));

  return { nodes, edges };
}

export function ERDiagram({ tables, foreignKeys, onTableClick }: ERDiagramProps) {
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => getLayoutedElements(tables, foreignKeys),
    [tables, foreignKeys]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  useEffect(() => {
    const { nodes: newNodes, edges: newEdges } = getLayoutedElements(tables, foreignKeys);
    setNodes(newNodes);
    setEdges(newEdges);
  }, [tables, foreignKeys, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onTableClick?.(node.id);
    },
    [onTableClick]
  );

  if (tables.length === 0) {
    return (
      <div className="h-[calc(80vh-120px)] min-h-[400px] border rounded-lg flex items-center justify-center text-muted-foreground">
        暂无数据表，请先创建表
      </div>
    );
  }

  return (
    <div className="h-[calc(80vh-120px)] min-h-[400px] border rounded-lg">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          connectionLineType={ConnectionLineType.SmoothStep}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
        >
          <Background color="hsl(var(--muted-foreground))" gap={16} size={1} />
          <Controls />
          <MiniMap
            nodeColor="hsl(var(--primary))"
            maskColor="hsl(var(--background) / 0.8)"
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
