interface CreateDruviaHelperOptions {
  apiBaseUrl: string;
  internalToken: string;
  fetchFn?: typeof fetch;
}

export interface DruviaWorkerHelper {
  graphql<T = unknown>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{ data: T | null; errors?: unknown[] | null }>;
}

export function resolveDruviaApiBaseUrl(
  apiBaseUrl?: string,
  envGet?: (name: string) => string | undefined
): string | undefined {
  const explicitBaseUrl = apiBaseUrl?.trim();
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  const envBaseUrl = envGet?.('DRUVIA_API_URL')?.trim();
  return envBaseUrl || undefined;
}

export function createDruviaHelper(options: CreateDruviaHelperOptions): DruviaWorkerHelper {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.apiBaseUrl.replace(/\/+$/, '');

  return {
    async graphql<T = unknown>(query: string, variables?: Record<string, unknown>) {
      const response = await fetchFn(`${baseUrl}/api/internal/functions/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-druvia-internal-token': options.internalToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      const contentType = response.headers?.get('content-type') ?? 'application/json';
      const responseBody = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      if (!response.ok) {
        throw new Error(
          typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)
        );
      }

      return responseBody as { data: T | null; errors?: unknown[] | null };
    },
  };
}
