'use client';

import { useState, useEffect } from 'react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { api } from '@/lib/api';

interface RestClientProps {
  openApiUrl?: string;
}

export function RestClient({ openApiUrl }: RestClientProps) {
  const [spec, setSpec] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!openApiUrl) {
      setLoading(false);
      return;
    }

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

  if (!openApiUrl) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        未配置 OpenAPI URL
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        加载 OpenAPI 规范中...
      </div>
    );
  }

  if (error || !spec) {
    return (
      <div className="h-full flex items-center justify-center text-red-500">
        {error || '无法加载 OpenAPI 规范'}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <ApiReferenceReact
        configuration={{
          spec: {
            content: spec,
          },
          hideModels: true,
          hideDownloadButton: true,
        }}
      />
    </div>
  );
}
