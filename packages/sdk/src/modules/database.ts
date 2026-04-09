import { QueryBuilder } from './query-builder.js'
import type { FetchFn, DruviaResponse } from '../types.js'
import { parseGraphqlResponsePayload, readGraphqlResponsePayload } from '../lib/graphql-response.js'

export class DruviaDatabase {
  private graphqlUrl: string
  private fetchFn: FetchFn
  private schema: string | undefined

  constructor(graphqlUrl: string, fetchFn: FetchFn, schema?: string) {
    this.graphqlUrl = graphqlUrl
    this.fetchFn = fetchFn
    this.schema = schema
  }

  from<T = unknown>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(table, this.graphqlUrl, this.fetchFn, this.schema)
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<DruviaResponse<T>> {
    try {
      const response = await this.fetchFn(this.graphqlUrl, {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
      })
      const payload = await readGraphqlResponsePayload(response)
      const parsed = parseGraphqlResponsePayload(payload)
      if (parsed.error) {
        return { data: null, error: parsed.error }
      }
      return { data: parsed.data as T, error: null }
    } catch (err) {
      return { data: null, error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : String(err) } }
    }
  }
}
