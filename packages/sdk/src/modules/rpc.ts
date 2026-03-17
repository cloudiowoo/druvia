import type { FetchFn, DruviaResponse } from '../types.js'

export class DruviaRpc {
  private baseUrl: string
  private projectId: string
  private fetchFn: FetchFn

  constructor(baseUrl: string, projectId: string, fetchFn: FetchFn) {
    this.baseUrl = baseUrl
    this.projectId = projectId
    this.fetchFn = fetchFn
  }

  async call<T = unknown>(functionName: string, args?: Record<string, unknown>): Promise<DruviaResponse<T>> {
    try {
      const response = await this.fetchFn(
        `${this.baseUrl}/projects/${this.projectId}/rpc/${functionName}`,
        {
          method: 'POST',
          body: JSON.stringify({ args: args ?? {} }),
        }
      )
      const json = await response.json()
      if (!response.ok) {
        return { data: null, error: json.error ?? { code: 'RPC_ERROR', message: `RPC call to ${functionName} failed` } }
      }
      return { data: json.data ?? json, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }
}
