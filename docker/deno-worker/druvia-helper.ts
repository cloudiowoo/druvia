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
  storage: {
    upload(input: {
      bucket: string;
      path: string;
      data: Uint8Array | ArrayBuffer | Blob;
      contentType: string;
    }): Promise<{
      path: string;
      publicUrl: string | null;
      object: Record<string, unknown>;
    }>;
    remove(input: {
      bucket: string;
      path: string;
      ignoreMissing?: boolean;
    }): Promise<{
      path: string;
      deleted: boolean;
    }>;
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers?.get('content-type') ?? 'application/json';
  return contentType.includes('application/json')
    ? await response.json()
    : await response.text();
}

function ensureUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

async function toBase64(data: Uint8Array | ArrayBuffer | Blob): Promise<string> {
  const bytes = data instanceof Blob
    ? new Uint8Array(await data.arrayBuffer())
    : ensureUint8Array(data);

  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
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

      const responseBody = await readResponseBody(response);

      if (!response.ok) {
        throw new Error(
          typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)
        );
      }

      return responseBody as { data: T | null; errors?: unknown[] | null };
    },
    storage: {
      async upload(input) {
        const response = await fetchFn(`${baseUrl}/api/internal/functions/storage/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-druvia-internal-token': options.internalToken,
          },
          body: JSON.stringify({
            bucket: input.bucket,
            path: input.path,
            contentType: input.contentType,
            dataBase64: await toBase64(input.data),
          }),
        });

        const responseBody = await readResponseBody(response);
        if (!response.ok) {
          throw new Error(
            typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)
          );
        }

        const payload = responseBody as {
          data?: {
            path: string;
            publicUrl: string | null;
            object: Record<string, unknown>;
          };
        };

        if (!payload.data) {
          throw new Error('Invalid internal storage response');
        }

        return payload.data;
      },
      async remove(input) {
        const response = await fetchFn(`${baseUrl}/api/internal/functions/storage/remove`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-druvia-internal-token': options.internalToken,
          },
          body: JSON.stringify({
            bucket: input.bucket,
            path: input.path,
            ...(input.ignoreMissing !== undefined ? { ignoreMissing: input.ignoreMissing } : {}),
          }),
        });

        const responseBody = await readResponseBody(response);
        if (!response.ok) {
          throw new Error(
            typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)
          );
        }

        const payload = responseBody as {
          data?: {
            path: string;
            deleted: boolean;
          };
        };

        if (!payload.data) {
          throw new Error('Invalid internal storage response');
        }

        return payload.data;
      },
    },
  };
}
