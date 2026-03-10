'use client';

import { useEffect, useState } from 'react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { api } from '@/lib/api';

interface RestClientProps {
  projectId: string;
}

export function RestClient({ projectId }: RestClientProps) {
  const [spec, setSpec] = useState<object | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchOpenApiSpec() {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/v1/projects/${projectId}/openapi`,
          {
            headers: {
              Authorization: `Bearer ${api.getToken()}`,
            },
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`);
        }

        const data = await response.json();
        setSpec(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load REST client');
      } finally {
        setLoading(false);
      }
    }

    fetchOpenApiSpec();
  }, [projectId]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        加载 REST 客户端中...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-red-500">
        {error}
      </div>
    );
  }

  if (!spec) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        无法加载 REST 客户端
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <ApiReferenceReact
        configuration={{
          content: spec,
          hideModels: true,
          hideDownloadButton: true,
        }}
      />
    </div>
  );
}
