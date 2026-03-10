'use client';

import { GraphQLEditor } from './GraphQLEditor';

interface GraphQLPlaygroundProps {
  hasuraUrl: string;  // 保留接口兼容，但不再使用
  projectId: string;
}

// 包装组件，保持向后兼容
export function GraphQLPlayground({ projectId }: GraphQLPlaygroundProps) {
  return <GraphQLEditor projectId={projectId} />;
}
