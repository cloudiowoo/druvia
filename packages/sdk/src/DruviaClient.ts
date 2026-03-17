import type { DruviaClientOptions, DruviaResponse, FetchFn } from './types.js'
import { getDefaultFetch, createFetchWrapper } from './lib/fetch-adapter.js'
import { getDefaultStorage } from './lib/storage-adapter.js'
import { getDefaultWebSocketFactory } from './lib/websocket-adapter.js'
import { DruviaAuth } from './modules/auth.js'
import { DruviaDatabase } from './modules/database.js'
import { DruviaStorage } from './modules/storage.js'
import { DruviaRealtime, RealtimeChannel } from './modules/realtime.js'
import { DruviaRpc } from './modules/rpc.js'
import { DruviaFunctions } from './modules/functions.js'
import { QueryBuilder } from './modules/query-builder.js'

export class DruviaClient {
  readonly auth: DruviaAuth
  readonly storage: DruviaStorage
  readonly functions: DruviaFunctions

  private database: DruviaDatabase
  private rpcModule: DruviaRpc
  private realtime: DruviaRealtime | null
  private authedFetch: FetchFn

  constructor(baseUrl: string, apiKey: string, options: DruviaClientOptions) {
    const rawFetch = options.fetch ?? getDefaultFetch()
    const storageAdapter = options.storage ?? getDefaultStorage()
    const apiBase = baseUrl.replace(/\/+$/, '')
    const schema = options.schema ?? `dru_${options.projectId.replace(/-/g, '_')}`

    let cachedToken: string | null = null
    this.auth = new DruviaAuth(apiBase, rawFetch, storageAdapter)
    this.auth.onAuthStateChange((_event, session) => {
      cachedToken = session?.accessToken ?? null
    })
    const initialRaw = storageAdapter.getItem('druvia.session')
    if (typeof initialRaw === 'string') {
      try { cachedToken = JSON.parse(initialRaw).accessToken } catch { /* ignore */ }
    }

    this.authedFetch = createFetchWrapper(apiBase, apiKey, rawFetch, () => cachedToken)
    const graphqlUrl = `${apiBase}/projects/${options.projectId}/graphql`
    this.database = new DruviaDatabase(graphqlUrl, this.authedFetch, schema)
    this.storage = new DruviaStorage(apiBase, options.projectId, this.authedFetch)
    this.rpcModule = new DruviaRpc(apiBase, options.projectId, this.authedFetch)
    this.functions = new DruviaFunctions(apiBase, options.projectId, this.authedFetch)

    const wsFactory = options.websocket ?? getDefaultWebSocketFactory()
    if (wsFactory) {
      const wsUrl = options.realtimeUrl
        ? options.realtimeUrl.replace(/\/+$/, '') + '/v1/graphql'
        : baseUrl.replace(/^http/, 'ws').replace(/:\d+/, ':8080') + '/v1/graphql'
      this.realtime = new DruviaRealtime(wsUrl, wsFactory)
    } else {
      this.realtime = null
    }
  }

  from<T = unknown>(table: string): QueryBuilder<T> {
    return this.database.from<T>(table)
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<DruviaResponse<T>> {
    return this.database.graphql<T>(query, variables)
  }

  async rpc<T = unknown>(functionName: string, args?: Record<string, unknown>): Promise<DruviaResponse<T>> {
    return this.rpcModule.call<T>(functionName, args)
  }

  channel(name: string): RealtimeChannel {
    if (!this.realtime) {
      throw new Error('@druvia/sdk: No WebSocket available. Pass a websocket factory in createClient options.')
    }
    return this.realtime.channel(name)
  }
}

export function createClient(baseUrl: string, apiKey: string, options: DruviaClientOptions): DruviaClient {
  return new DruviaClient(baseUrl, apiKey, options)
}