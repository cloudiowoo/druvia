import type { FetchFn, DruviaResponse } from '../types.js'

interface InvokeOptions {
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

export class DruviaFunctions {
  private baseUrl: string
  private projectId: string
  private fetchFn: FetchFn

  constructor(baseUrl: string, projectId: string, fetchFn: FetchFn) {
    this.baseUrl = baseUrl
    this.projectId = projectId
    this.fetchFn = fetchFn
  }

  async invoke<T = unknown>(functionName: string, options?: InvokeOptions): Promise<DruviaResponse<T>> {
    try {
      const response = await this.fetchFn(
        `${this.baseUrl}/projects/${this.projectId}/functions/${functionName}/invoke`,
        {
          method: 'POST',
          body: JSON.stringify(options?.body ?? {}),
          headers: options?.headers,
        }
      )
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'FUNCTION_ERROR', message: `Function ${functionName} failed` } }
      }
      return { data: json as T, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }
}
