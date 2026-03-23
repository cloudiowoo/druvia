import type { DruviaClientOptions, DruviaResponse, FetchFn } from './types.js'
import { getDefaultFetch, createFetchWrapper } from './lib/fetch-adapter.js'
import { getDefaultStorage } from './lib/storage-adapter.js'
import { getDefaultWebSocketFactory } from './lib/websocket-adapter.js'
import { DruviaAuth } from './modules/auth.js'
import { DruviaProjectAuth } from './modules/project-auth.js'
import { DruviaDatabase } from './modules/database.js'
import { DruviaStorage } from './modules/storage.js'
import { DruviaRealtime, RealtimeChannel } from './modules/realtime.js'
import { DruviaRpc } from './modules/rpc.js'
import { DruviaFunctions } from './modules/functions.js'
import { QueryBuilder } from './modules/query-builder.js'

export class DruviaClient {
  readonly auth: DruviaAuth
  readonly projectAuth: DruviaProjectAuth
  readonly storage: DruviaStorage
  readonly functions: DruviaFunctions

  private database: DruviaDatabase
  private rpcModule: DruviaRpc
  private realtime: DruviaRealtime | null
  private platformFetch: FetchFn
  private projectFetch: FetchFn

  constructor(baseUrl: string, apiKey: string, options: DruviaClientOptions) {
    const rawFetch = options.fetch ?? getDefaultFetch()
    const storageAdapter = options.storage ?? getDefaultStorage()
    const apiBase = baseUrl.replace(/\/+$/, '')
    const schema = options.schema

    if (!schema) {
      console.warn('@druvia/sdk: No schema provided. Use createClient with { schema } option or call DruviaClient.create() for auto-detection.')
    }

    let cachedPlatformToken: string | null = null
    let cachedProjectToken: string | null = null
    this.auth = new DruviaAuth(apiBase, rawFetch, storageAdapter)
    this.auth.onAuthStateChange((_event, session) => {
      cachedPlatformToken = session?.accessToken ?? null
    })
    this.projectAuth = new DruviaProjectAuth(
      apiBase,
      options.projectId,
      createFetchWrapper(apiBase, apiKey, rawFetch, () => cachedProjectToken),
      storageAdapter
    )
    this.projectAuth.onAuthStateChange((_event, session) => {
      cachedProjectToken = session?.accessToken ?? null
    })
    const initialRaw = storageAdapter.getItem('druvia.session')
    if (typeof initialRaw === 'string') {
      try { cachedPlatformToken = JSON.parse(initialRaw).accessToken } catch { /* ignore */ }
    }
    const initialProjectRaw = storageAdapter.getItem('druvia.project_session')
    if (typeof initialProjectRaw === 'string') {
      try { cachedProjectToken = JSON.parse(initialProjectRaw).accessToken } catch { /* ignore */ }
    }

    this.platformFetch = createFetchWrapper(apiBase, apiKey, rawFetch, () => cachedPlatformToken)
    this.projectFetch = createFetchWrapper(apiBase, apiKey, rawFetch, () => cachedProjectToken ?? cachedPlatformToken)
    const graphqlUrl = `${apiBase}/projects/${options.projectId}/graphql`
    this.database = new DruviaDatabase(graphqlUrl, this.platformFetch, schema)
    this.storage = new DruviaStorage(apiBase, options.projectId, this.platformFetch)
    this.rpcModule = new DruviaRpc(apiBase, options.projectId, this.projectFetch)
    this.functions = new DruviaFunctions(apiBase, options.projectId, this.projectFetch)

    const wsFactory = options.websocket ?? getDefaultWebSocketFactory()
    if (wsFactory) {
      const wsUrl = options.realtimeUrl
        ? options.realtimeUrl.replace(/\/+$/, '') + '/v1/graphql'
        : baseUrl.replace(/^http/, 'ws') + '/v1/graphql'
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

  removeChannel(channel: RealtimeChannel): void {
    if (!this.realtime) {
      throw new Error('@druvia/sdk: No WebSocket available.')
    }
    this.realtime.removeChannel(channel)
  }

  /** Async factory — auto-detects schema via API key validation */
  static async create(baseUrl: string, apiKey: string, options: DruviaClientOptions): Promise<DruviaClient> {
    if (options.schema) {
      return new DruviaClient(baseUrl, apiKey, options)
    }

    const apiBase = baseUrl.replace(/\/+$/, '')
    const rawFetch = options.fetch ?? getDefaultFetch()
    try {
      const res = await rawFetch(`${apiBase}/api-keys/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: apiKey }),
      })
      const json = await res.json()
      if (json.success && json.data?.schemaName) {
        return new DruviaClient(baseUrl, apiKey, { ...options, schema: json.data.schemaName })
      }
    } catch { /* fallback to no schema */ }

    return new DruviaClient(baseUrl, apiKey, options)
  }
}

export function createClient(baseUrl: string, apiKey: string, options: DruviaClientOptions): DruviaClient {
  return new DruviaClient(baseUrl, apiKey, options)
}
