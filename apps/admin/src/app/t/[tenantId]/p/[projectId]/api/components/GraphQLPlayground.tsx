'use client';

import { useEffect, useState, useRef, Component, ReactNode } from 'react';
import { createGraphiQLFetcher } from '@graphiql/toolkit';
import { api } from '@/lib/api';

// Import GraphiQL CSS - style.css contains the full styles including CSS variables
import 'graphiql/style.css';

// Error boundary to catch Monaco errors
class GraphiQLErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    // Ignore Monaco-related errors
    if (
      error.message.includes('toUrl') ||
      error.message.includes('monaco') ||
      error.message.includes('Monaco')
    ) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface GraphQLPlaygroundProps {
  hasuraUrl: string;
  projectId: string;
}

export function GraphQLPlayground({ hasuraUrl, projectId }: GraphQLPlaygroundProps) {
  const [GraphiQL, setGraphiQL] = useState<React.ComponentType<{ fetcher: ReturnType<typeof createGraphiQLFetcher> }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Import worker setup first, then GraphiQL
    // This ensures Monaco workers are configured before GraphiQL loads
    import('graphiql/setup-workers/webpack')
      .then(() => import('graphiql'))
      .then((mod) => {
        setGraphiQL(() => mod.GraphiQL);
      })
      .catch((err) => {
        console.error('Failed to load GraphiQL:', err);
        setError('Failed to load GraphQL Playground');
      });
  }, []);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  if (!GraphiQL) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted-foreground">Loading GraphQL Playground...</div>
      </div>
    );
  }

  // Use a custom fetcher that proxies through our API to avoid exposing admin secret
  const fetcher = createGraphiQLFetcher({
    url: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/v1/projects/${projectId}/graphql`,
    headers: {
      'Authorization': `Bearer ${api.getToken()}`,
    },
  });

  return (
    <div className="h-full">
      <GraphiQLErrorBoundary
        fallback={
          <div className="h-full flex items-center justify-center text-muted-foreground">
            GraphQL Playground encountered an error. Please refresh the page.
          </div>
        }
      >
        <GraphiQL fetcher={fetcher} />
      </GraphiQLErrorBoundary>
    </div>
  );
}
