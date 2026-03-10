'use client';

import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';

interface RestClientProps {
  openApiUrl?: string;
}

export function RestClient({ openApiUrl }: RestClientProps) {
  if (!openApiUrl) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        未配置 OpenAPI URL
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <ApiReferenceReact
        configuration={{
          url: openApiUrl,
          hideModels: true,
          hideDownloadButton: true,
        }}
      />
    </div>
  );
}
