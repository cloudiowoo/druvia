'use client';

import { useState, useEffect } from 'react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { api } from '@/lib/api';

interface ApiDocumentationProps {
  projectId: string;
}

export function ApiDocumentation({ projectId }: ApiDocumentationProps) {
  const [spec, setSpec] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const openApiUrl = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/v1/projects/${projectId}/openapi`;

  useEffect(() => {
    const fetchSpec = async () => {
      try {
        const response = await fetch(openApiUrl, {
          headers: {
            'Authorization': `Bearer ${api.getToken()}`,
          },
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`);
        }
        const data = await response.json();
        setSpec(JSON.stringify(data));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load OpenAPI spec');
      } finally {
        setLoading(false);
      }
    };

    fetchSpec();
  }, [openApiUrl]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        加载 API 文档中...
      </div>
    );
  }

  if (error || !spec) {
    return (
      <div className="h-full flex items-center justify-center text-red-500">
        {error || '无法加载 API 文档'}
      </div>
    );
  }

  return (
    <div className="h-full">
      <ApiReferenceReact
        configuration={{
          spec: { content: spec },
          theme: 'default',
        }}
      />
    </div>
  );
}
