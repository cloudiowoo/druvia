import type {
  DruviaError,
  RealtimeChannelStatus,
  RealtimeChannelStatusCallback,
  RealtimeSubscription,
  WebSocketFactory,
  WebSocketLike,
} from '../types.js'
import { escapeGraphQLString } from '../lib/graphql-builder.js'
import {
  RealtimeTokenRequestError,
  type RealtimeAccessToken,
  type RealtimeTokenProvider,
} from './realtime-token.js'

interface SubscriptionConfig {
  event: '*' | 'INSERT' | 'UPDATE' | 'DELETE'
  table: string
  schema?: string
  filter?: string
  fields?: string
}

interface ChangeEvent {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: Record<string, unknown> | null
  old: Record<string, unknown> | null
}

type ChangeCallback = (event: ChangeEvent) => void

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000]

function normalizeRealtimeUrl(value: string): string {
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'ws:' && url.protocol !== 'wss:')
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
    ) {
      throw new Error('invalid Realtime URL')
    }

    const trimmedPath = url.pathname.replace(/\/+$/, '')
    url.pathname = trimmedPath.endsWith('/v1/graphql')
      ? trimmedPath
      : `${trimmedPath}/v1/graphql`.replace(/^\/{2,}/, '/')
    return url.toString().replace(/\/$/, '')
  } catch {
    throw new Error('@druvia/sdk: Realtime URL must be an absolute ws:// or wss:// URL without credentials, query, or fragment')
  }
}

function toDruviaError(error: unknown): DruviaError {
  if (error instanceof RealtimeTokenRequestError) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'REALTIME_CONNECTION_ERROR',
    message: 'Realtime connection failed',
  }
}

export class RealtimeChannel {
  private readonly tokenProvider: RealtimeTokenProvider
  private readonly wsFactory: WebSocketFactory
  private readonly wsUrlOverride?: string
  private readonly onDispose: (channel: RealtimeChannel) => void
  private configs: Array<{ config: SubscriptionConfig; callback: ChangeCallback }> = []
  private ws: WebSocketLike | null = null
  private snapshot = new Map<string, Record<string, unknown>[]>()
  private operationCounter = 0
  private generation = 0
  private lifecycleGeneration = 0
  private subscribed = false
  private disposed = false
  private retryHalted = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private renewalTimer: ReturnType<typeof setTimeout> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private tokenRequest: Promise<void> | null = null
  private tokenRequestGeneration = 0
  private statusCallback: RealtimeChannelStatusCallback | null = null
  private activeOperationIds = new Set<string>()

  constructor(input: {
    tokenProvider: RealtimeTokenProvider
    wsFactory: WebSocketFactory
    wsUrlOverride?: string
    onDispose: (channel: RealtimeChannel) => void
  }) {
    this.tokenProvider = input.tokenProvider
    this.wsFactory = input.wsFactory
    this.wsUrlOverride = input.wsUrlOverride
    this.onDispose = input.onDispose
  }

  on(type: 'postgres_changes', config: SubscriptionConfig, callback: ChangeCallback): this {
    if (this.disposed) {
      throw new Error('@druvia/sdk: Realtime channel has been removed')
    }
    if (type === 'postgres_changes') {
      this.configs.push({ config, callback })
    }
    return this
  }

  subscribe(callback?: RealtimeChannelStatusCallback): RealtimeSubscription {
    if (this.disposed) {
      throw new Error('@druvia/sdk: Realtime channel has been removed')
    }
    if (this.subscribed) {
      throw new Error('@druvia/sdk: Realtime channel is already active')
    }

    this.subscribed = true
    this.retryHalted = false
    this.reconnectAttempt = 0
    this.lifecycleGeneration++
    const lifecycle = this.lifecycleGeneration
    this.statusCallback = callback ?? null
    this.emitStatus('CONNECTING')
    this.startConnection()

    return {
      unsubscribe: () => {
        if (this.subscribed && this.lifecycleGeneration === lifecycle) {
          this.stopLifecycle(false)
        }
      },
    }
  }

  handleIdentityChange(): void {
    if (!this.subscribed || this.disposed) return

    this.retryHalted = false
    this.reconnectAttempt = 0
    this.cancelReconnectTimer()
    this.invalidateTokenRequest()
    this.invalidateActiveSocket(true)
    this.snapshot.clear()
    this.emitStatus('CONNECTING')
    this.startConnection()
  }

  dispose(): void {
    if (this.disposed) return
    if (this.subscribed) {
      this.stopLifecycle(true)
    } else {
      this.invalidateTokenRequest()
      this.clearAllTimers()
      this.invalidateActiveSocket(false)
    }
    this.disposed = true
    this.configs = []
    this.snapshot.clear()
    this.onDispose(this)
  }

  private startConnection(): void {
    if (!this.subscribed || this.disposed || this.retryHalted || this.tokenRequest) return

    const requestGeneration = ++this.tokenRequestGeneration
    const request = this.acquireAndInstall(requestGeneration)
    this.tokenRequest = request
    void request.finally(() => {
      if (this.tokenRequest === request) {
        this.tokenRequest = null
      }
    })
  }

  private async acquireAndInstall(requestGeneration: number): Promise<void> {
    try {
      const access = await this.tokenProvider()
      if (!this.isTokenRequestCurrent(requestGeneration)) return
      this.installSocket(access)
    } catch (error) {
      if (!this.isTokenRequestCurrent(requestGeneration)) return

      const tokenError = error instanceof RealtimeTokenRequestError
        ? error
        : new RealtimeTokenRequestError({
            code: 'REALTIME_TOKEN_NETWORK_ERROR',
            message: 'Realtime token request failed',
            retryable: true,
          })
      if (!tokenError.retryable) {
        this.retryHalted = true
        this.invalidateActiveSocket(true)
        this.emitStatus('CHANNEL_ERROR', toDruviaError(tokenError))
        return
      }

      this.scheduleReconnect(tokenError.retryAfterMs)
    }
  }

  private isTokenRequestCurrent(requestGeneration: number): boolean {
    return this.subscribed
      && !this.disposed
      && requestGeneration === this.tokenRequestGeneration
  }

  private installSocket(access: RealtimeAccessToken): void {
    const websocketUrl = this.wsUrlOverride ?? normalizeRealtimeUrl(access.websocketUrl)
    const previousSocket = this.ws
    this.clearSocketTimers()
    this.cancelReconnectTimer()
    const socketGeneration = ++this.generation
    this.ws = null
    if (previousSocket) previousSocket.close()

    let socket: WebSocketLike
    try {
      socket = this.wsFactory(websocketUrl, ['graphql-transport-ws'])
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = socket

    socket.onOpen(() => {
      if (!this.isSocketCurrent(socketGeneration, socket)) return
      socket.send(JSON.stringify({
        type: 'connection_init',
        payload: {
          headers: { Authorization: `Bearer ${access.token}` },
        },
      }))
      this.ackTimer = setTimeout(() => {
        if (!this.isSocketCurrent(socketGeneration, socket)) return
        this.invalidateActiveSocket(false)
        this.scheduleReconnect()
      }, 10_000)
    })

    socket.onMessage((raw) => {
      if (!this.isSocketCurrent(socketGeneration, socket)) return
      this.handleMessage(raw, socketGeneration, socket, access)
    })

    socket.onClose((event) => {
      if (!this.isSocketCurrent(socketGeneration, socket)) return
      this.ws = null
      this.generation++
      this.clearSocketTimers()
      if (event?.code === 4401 || event?.code === 4403) {
        this.retryHalted = true
        this.emitStatus('CHANNEL_ERROR', {
          code: 'REALTIME_AUTH_ERROR',
          message: 'Realtime authorization failed',
        })
        return
      }
      this.scheduleReconnect()
    })

    socket.onError(() => {
      if (!this.isSocketCurrent(socketGeneration, socket)) return
      this.invalidateActiveSocket(false)
      this.scheduleReconnect()
    })
  }

  private handleMessage(
    raw: string,
    socketGeneration: number,
    socket: WebSocketLike,
    access: RealtimeAccessToken
  ): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    if (message.type === 'ping') {
      socket.send(JSON.stringify({
        type: 'pong',
        ...(message.payload !== undefined ? { payload: message.payload } : {}),
      }))
      return
    }

    if (message.type === 'connection_ack') {
      this.clearTimer('ack')
      this.retryHalted = false
      this.reconnectAttempt = 0
      this.snapshot.clear()
      this.activeOperationIds.clear()
      this.sendSubscriptions(socket)
      this.emitStatus('SUBSCRIBED')
      this.scheduleRenewal(access, socketGeneration, socket)
      return
    }

    if (message.type === 'error') {
      this.retryHalted = true
      this.invalidateActiveSocket(true)
      this.emitStatus('CHANNEL_ERROR', {
        code: 'REALTIME_OPERATION_ERROR',
        message: 'Realtime subscription operation failed',
      })
      return
    }

    if (message.type !== 'next') return
    const payload = message.payload as { data?: Record<string, unknown> } | undefined
    if (!payload?.data) return
    const tableName = Object.keys(payload.data)[0]
    if (!tableName) return
    const newRows = (payload.data[tableName] as Record<string, unknown>[] | undefined) ?? []
    const oldRows = this.snapshot.get(tableName)
    if (!oldRows) {
      this.snapshot.set(tableName, structuredClone(newRows))
      return
    }

    const config = this.configs.find((item) => item.config.table === tableName)
    if (!config) return
    this.diffAndEmit(oldRows, newRows, config.config, config.callback)
    this.snapshot.set(tableName, structuredClone(newRows))
  }

  private sendSubscriptions(socket: WebSocketLike): void {
    for (const { config } of this.configs) {
      const id = String(++this.operationCounter)
      this.activeOperationIds.add(id)
      const fields = config.fields ?? 'id'
      const filterClause = config.filter ? `(where: {${this.parseFilter(config.filter)}})` : ''
      const query = `subscription { ${config.table}${filterClause} { ${fields} } }`
      socket.send(JSON.stringify({ id, type: 'subscribe', payload: { query } }))
    }
  }

  private scheduleRenewal(
    access: RealtimeAccessToken,
    socketGeneration: number,
    socket: WebSocketLike
  ): void {
    const expiresAt = Date.parse(access.expiresAt)
    const renewalDelay = Math.max(1000, expiresAt - Date.now() - 30_000)
    const expiryDelay = Math.max(0, expiresAt - Date.now())

    this.renewalTimer = setTimeout(() => {
      if (!this.isSocketCurrent(socketGeneration, socket)) return
      this.startConnection()
    }, renewalDelay)
    this.expiryTimer = setTimeout(() => {
      if (!this.isSocketCurrent(socketGeneration, socket)) return
      this.invalidateActiveSocket(false)
      this.emitStatus('RECONNECTING')
      if (!this.reconnectTimer && !this.tokenRequest) {
        this.startConnection()
      }
    }, expiryDelay)
  }

  private scheduleReconnect(retryAfterMs?: number): void {
    if (!this.subscribed || this.disposed || this.retryHalted || this.reconnectTimer) return
    const baseDelay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    this.reconnectAttempt++
    const jitteredDelay = Math.round(baseDelay * (0.8 + Math.random() * 0.4))
    const delay = Math.max(jitteredDelay, retryAfterMs ?? 0)
    this.emitStatus('RECONNECTING')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.startConnection()
    }, delay)
  }

  private invalidateActiveSocket(sendComplete: boolean): void {
    const socket = this.ws
    this.generation++
    this.ws = null
    this.clearSocketTimers()
    if (!socket) return

    if (sendComplete) {
      for (const id of this.activeOperationIds) {
        try { socket.send(JSON.stringify({ id, type: 'complete' })) } catch { /* closed */ }
      }
    }
    this.activeOperationIds.clear()
    socket.close()
  }

  private isSocketCurrent(generation: number, socket: WebSocketLike): boolean {
    return this.subscribed
      && !this.disposed
      && generation === this.generation
      && socket === this.ws
  }

  private stopLifecycle(disposing: boolean): void {
    if (!this.subscribed) return
    this.subscribed = false
    this.lifecycleGeneration++
    this.retryHalted = false
    this.invalidateTokenRequest()
    this.clearAllTimers()
    this.invalidateActiveSocket(true)
    this.snapshot.clear()
    this.activeOperationIds.clear()
    this.emitStatus('CLOSED')
    this.statusCallback = null
    if (disposing) this.configs = []
  }

  private invalidateTokenRequest(): void {
    this.tokenRequestGeneration++
    this.tokenRequest = null
  }

  private clearSocketTimers(): void {
    this.clearTimer('ack')
    this.clearTimer('renewal')
    this.clearTimer('expiry')
  }

  private clearAllTimers(): void {
    this.clearSocketTimers()
    this.cancelReconnectTimer()
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearTimer(timer: 'ack' | 'renewal' | 'expiry'): void {
    const key = `${timer}Timer` as 'ackTimer' | 'renewalTimer' | 'expiryTimer'
    const value = this[key]
    if (value) clearTimeout(value)
    this[key] = null
  }

  private emitStatus(status: RealtimeChannelStatus, error?: DruviaError): void {
    this.statusCallback?.(status, error)
  }

  private diffAndEmit(
    oldRows: Record<string, unknown>[],
    newRows: Record<string, unknown>[],
    config: SubscriptionConfig,
    callback: ChangeCallback,
  ) {
    const getId = (row: Record<string, unknown>) => row.id ?? JSON.stringify(row)
    const oldMap = new Map(oldRows.map((row) => [getId(row), row]))
    const newMap = new Map(newRows.map((row) => [getId(row), row]))

    for (const [id, row] of newMap) {
      if (!oldMap.has(id) && (config.event === '*' || config.event === 'INSERT')) {
        callback({ eventType: 'INSERT', new: row, old: null })
      }
    }
    for (const [id, newRow] of newMap) {
      const oldRow = oldMap.get(id)
      if (
        oldRow
        && JSON.stringify(oldRow) !== JSON.stringify(newRow)
        && (config.event === '*' || config.event === 'UPDATE')
      ) {
        callback({ eventType: 'UPDATE', new: newRow, old: oldRow })
      }
    }
    for (const [id, row] of oldMap) {
      if (!newMap.has(id) && (config.event === '*' || config.event === 'DELETE')) {
        callback({ eventType: 'DELETE', new: null, old: row })
      }
    }
  }

  private parseFilter(filter: string): string {
    const match = filter.match(/^(\w+)=eq\.(.+)$/)
    return match
      ? `${match[1]}: {_eq: "${escapeGraphQLString(match[2])}"}`
      : filter
  }
}

export class DruviaRealtime {
  private readonly tokenProvider: RealtimeTokenProvider
  private readonly wsFactory: WebSocketFactory
  private readonly wsUrlOverride?: string
  private channels = new Set<RealtimeChannel>()

  constructor(
    tokenProvider: RealtimeTokenProvider,
    wsFactory: WebSocketFactory,
    realtimeUrl?: string
  ) {
    this.tokenProvider = tokenProvider
    this.wsFactory = wsFactory
    this.wsUrlOverride = realtimeUrl ? normalizeRealtimeUrl(realtimeUrl) : undefined
  }

  channel(_name: string): RealtimeChannel {
    const channel = new RealtimeChannel({
      tokenProvider: this.tokenProvider,
      wsFactory: this.wsFactory,
      wsUrlOverride: this.wsUrlOverride,
      onDispose: (disposed) => this.channels.delete(disposed),
    })
    this.channels.add(channel)
    return channel
  }

  removeChannel(channel: RealtimeChannel): void {
    if (!this.channels.has(channel)) return
    channel.dispose()
  }

  handleIdentityChange(): void {
    for (const channel of this.channels) {
      channel.handleIdentityChange()
    }
  }
}
