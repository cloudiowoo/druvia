'use client';

import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';

interface ApiDocumentationProps {
  projectId: string;
}

export function ApiDocumentation({ projectId }: ApiDocumentationProps) {
  const openApiUrl = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/v1/projects/${projectId}/openapi`;

  return (
    <div className="h-full">
      <ApiReferenceReact
        configuration={{
          url: openApiUrl,
          theme: 'default',
        }}
      />
    </div>
  );
}
