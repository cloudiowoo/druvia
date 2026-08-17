'use client';

import { GraphQLEditor } from './GraphQLEditor';

interface GraphQLPlaygroundProps {
  projectId: string;
}

export function GraphQLPlayground({ projectId }: GraphQLPlaygroundProps) {
  return <GraphQLEditor key={projectId} projectId={projectId} />;
}
