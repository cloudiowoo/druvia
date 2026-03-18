import type { WebSocketFactory, WebSocketLike } from '../types.js'
import { escapeGraphQLString } from '../lib/graphql-builder.js'

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

interface Subscription {
  unsubscribe: () => void
}

export class RealtimeChannel {
  private wsUrl: string
  private wsFactory: WebSocketFactory
  private configs: Array<{ config: SubscriptionConfig; callback: ChangeCallback }> = []
  private ws: WebSocketLike | null = null
  private snapshot: Map<string, Record<string, unknown>[]> = new Map()
  private subIdCounter = 0

  constructor(wsUrl: string, wsFactory: WebSocketFactory) {
    this.wsUrl = wsUrl
    this.wsFactory = wsFactory
  }

  on(type: 'postgres_changes', config: SubscriptionConfig, callback: ChangeCallback): this {
    this.configs.push({ config, callback })
    return this
  }

  subscribe(): Subscription {
    this.ws = this.wsFactory(this.wsUrl, ['graphql-transport-ws'])

    this.ws.onOpen(() => {
      this.ws!.send(JSON.stringify({ type: 'connection_init', payload: {} }))
    })

    this.ws.onMessage((raw: string) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw)
      } catch {
        return // ignore non-JSON frames (ping, partial, etc.)
      }

      if (msg.type === 'connection_ack') {
        for (const { config } of this.configs) {
          this.subIdCounter++
          const id = String(this.subIdCounter)
          const fields = config.fields ?? 'id'
          const filterClause = config.filter ? `(where: {${this.parseFilter(config.filter)}})` : ''
          const query = `subscription { ${config.table}${filterClause} { ${fields} } }`
          this.ws!.send(JSON.stringify({ id, type: 'subscribe', payload: { query } }))
        }
        return
      }

      if (msg.type === 'next' && msg.payload?.data) {
        const tableName = Object.keys(msg.payload.data)[0]
        const newRows: Record<string, unknown>[] = msg.payload.data[tableName] ?? []
        const oldRows = this.snapshot.get(tableName) ?? null

        if (oldRows === null) {
          this.snapshot.set(tableName, structuredClone(newRows))
          return
        }

        const cfg = this.configs.find(c => c.config.table === tableName)
        if (!cfg) return

        this.diffAndEmit(oldRows, newRows, cfg.config, cfg.callback)
        this.snapshot.set(tableName, structuredClone(newRows))
      }
    })

    return {
      unsubscribe: () => {
        for (let i = 1; i <= this.subIdCounter; i++) {
          this.ws?.send(JSON.stringify({ id: String(i), type: 'complete' }))
        }
        this.ws?.close()
        this.ws = null
        this.snapshot.clear()
      }
    }
  }

  /** Close WebSocket and clean up resources */
  unsubscribeAll(): void {
    if (this.ws) {
      for (let i = 1; i <= this.subIdCounter; i++) {
        this.ws.send(JSON.stringify({ id: String(i), type: 'complete' }))
      }
      this.ws.close()
      this.ws = null
    }
    this.snapshot.clear()
    this.configs = []
  }

  private diffAndEmit(
    oldRows: Record<string, unknown>[],
    newRows: Record<string, unknown>[],
    config: SubscriptionConfig,
    callback: ChangeCallback,
  ) {
    const getId = (row: Record<string, unknown>) => row.id ?? JSON.stringify(row)
    const oldMap = new Map(oldRows.map(r => [getId(r), r]))
    const newMap = new Map(newRows.map(r => [getId(r), r]))

    for (const [id, row] of newMap) {
      if (!oldMap.has(id)) {
        if (config.event === '*' || config.event === 'INSERT') {
          callback({ eventType: 'INSERT', new: row, old: null })
        }
      }
    }

    for (const [id, newRow] of newMap) {
      const oldRow = oldMap.get(id)
      if (oldRow && JSON.stringify(oldRow) !== JSON.stringify(newRow)) {
        if (config.event === '*' || config.event === 'UPDATE') {
          callback({ eventType: 'UPDATE', new: newRow, old: oldRow })
        }
      }
    }

    for (const [id, row] of oldMap) {
      if (!newMap.has(id)) {
        if (config.event === '*' || config.event === 'DELETE') {
          callback({ eventType: 'DELETE', new: null, old: row })
        }
      }
    }
  }

  private parseFilter(filter: string): string {
    const match = filter.match(/^(\w+)=eq\.(.+)$/)
    if (match) {
      return `${match[1]}: {_eq: "${escapeGraphQLString(match[2])}"}`
    }
    return filter
  }
}

export class DruviaRealtime {
  private wsUrl: string
  private wsFactory: WebSocketFactory
  private channels: Set<RealtimeChannel> = new Set()

  constructor(wsUrl: string, wsFactory: WebSocketFactory) {
    this.wsUrl = wsUrl
    this.wsFactory = wsFactory
  }

  channel(_name: string): RealtimeChannel {
    const ch = new RealtimeChannel(this.wsUrl, this.wsFactory)
    this.channels.add(ch)
    return ch
  }

  removeChannel(channel: RealtimeChannel): void {
    channel.unsubscribeAll()
    this.channels.delete(channel)
  }
}