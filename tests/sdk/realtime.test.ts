import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DruviaRealtime, RealtimeChannel } from '../../packages/sdk/src/modules/realtime.js'
import {
  RealtimeTokenRequestError,
  type RealtimeAccessToken,
  type RealtimeTokenProvider,
} from '../../packages/sdk/src/modules/realtime-token.js'
import type {
  RealtimeChannelStatus,
  WebSocketFactory,
  WebSocketLike,
} from '../../packages/sdk/src/types.js'
import { createHttpOnlyUrlConstructor } from './http-only-url-runtime.js'

class FakeSocket implements WebSocketLike {
  readonly send = vi.fn()
  readonly close = vi.fn()
  private openHandler: (() => void) | null = null
  private messageHandler: ((data: string) => void) | null = null
  private closeHandler: ((event?: { code?: number; reason?: string }) => void) | null = null
  private errorHandler: ((error: unknown) => void) | null = null

  onOpen(cb: () => void) { this.openHandler = cb }
  onMessage(cb: (data: string) => void) { this.messageHandler = cb }
  onClose(cb: (event?: { code?: number; reason?: string }) => void) { this.closeHandler = cb }
  onError(cb: (error: unknown) => void) { this.errorHandler = cb }
  open() { this.openHandler?.() }
  message(value: unknown) { this.messageHandler?.(JSON.stringify(value)) }
  closed(event?: { code?: number; reason?: string }) { this.closeHandler?.(event) }
  error(error: unknown = new Error('socket failed')) { this.errorHandler?.(error) }
}

function createSocketFactory() {
  const sockets: FakeSocket[] = []
  const factory = vi.fn((() => {
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  }) as WebSocketFactory)
  return { factory, sockets }
}

function access(expiresInMs = 120_000, token = 'realtime-token'): RealtimeAccessToken {
  return {
    token,
    expiresIn: Math.ceil(expiresInMs / 1000),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    websocketUrl: 'wss://druvia.example.com/v1/graphql',
  }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createRealtime(provider: RealtimeTokenProvider, override?: string) {
  const sockets = createSocketFactory()
  return {
    ...sockets,
    realtime: new DruviaRealtime(provider, sockets.factory, override),
  }
}

describe('DruviaRealtime lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T10:00:00.000Z'))
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fetches a token before opening and completes the GraphQL handshake', async () => {
    const provider = vi.fn().mockResolvedValue(access())
    const { realtime, factory, sockets } = createRealtime(provider)
    const statuses: RealtimeChannelStatus[] = []
    const channel = realtime.channel('events')
      .on('postgres_changes', { event: '*', table: 'events', fields: 'id name' }, vi.fn())

    expect(channel).toBeInstanceOf(RealtimeChannel)
    channel.subscribe((status) => statuses.push(status))
    expect(provider).toHaveBeenCalledTimes(1)
    expect(factory).not.toHaveBeenCalled()

    await flushPromises()
    expect(factory).toHaveBeenCalledWith(
      'wss://druvia.example.com/v1/graphql',
      ['graphql-transport-ws']
    )
    const socket = sockets[0]
    socket.open()
    expect(JSON.parse(String(socket.send.mock.calls[0][0]))).toEqual({
      type: 'connection_init',
      payload: { headers: { Authorization: 'Bearer realtime-token' } },
    })
    expect(socket.send).toHaveBeenCalledTimes(1)

    socket.message({ type: 'connection_ack' })
    expect(JSON.parse(String(socket.send.mock.calls[1][0]))).toMatchObject({
      type: 'subscribe',
      payload: { query: expect.stringContaining('events') },
    })
    socket.message({ type: 'ping', payload: { requestId: 'ping_1' } })
    expect(JSON.parse(String(socket.send.mock.calls[2][0]))).toEqual({
      type: 'pong',
      payload: { requestId: 'ping_1' },
    })
    expect(statuses).toEqual(['CONNECTING', 'SUBSCRIBED'])
  })

  it('normalizes a valid URL override but still exchanges a token', async () => {
    const provider = vi.fn().mockResolvedValue(access())
    const { realtime, factory } = createRealtime(provider, 'ws://localhost:8180')

    realtime.channel('events').subscribe()
    await flushPromises()

    expect(provider).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith('ws://localhost:8180/v1/graphql', ['graphql-transport-ws'])
  })

  it('normalizes an override when the runtime URL implementation only supports HTTP(S)', async () => {
    vi.stubGlobal('URL', createHttpOnlyUrlConstructor(globalThis.URL))
    const provider = vi.fn().mockResolvedValue(access())
    const { realtime, factory } = createRealtime(provider, ' \nwss://druvia.example.com\t')

    realtime.channel('events').subscribe()
    await flushPromises()

    expect(factory).toHaveBeenCalledWith(
      'wss://druvia.example.com/v1/graphql',
      ['graphql-transport-ws']
    )
  })

  it('normalizes a token URL when the runtime URL implementation only supports HTTP(S)', async () => {
    vi.stubGlobal('URL', createHttpOnlyUrlConstructor(globalThis.URL))
    const provider = vi.fn().mockResolvedValue(access())
    const { realtime, factory } = createRealtime(provider)

    realtime.channel('events').subscribe()
    await flushPromises()

    expect(factory).toHaveBeenCalledWith(
      'wss://druvia.example.com/v1/graphql',
      ['graphql-transport-ws']
    )
  })

  it.each([
    'https://example.com',
    'wss://user:pass@example.com',
    'wss://example.com?token=secret',
    'not-a-url',
  ])('rejects invalid URL overrides before opening a socket: %s', (override) => {
    const provider = vi.fn().mockResolvedValue(access())
    const { factory } = createSocketFactory()

    expect(() => new DruviaRealtime(provider, factory, override)).toThrow('Realtime URL')
    expect(factory).not.toHaveBeenCalled()
  })

  it('closes an unacknowledged socket and retries after the ack timeout', async () => {
    const provider = vi.fn().mockResolvedValue(access())
    const { realtime, sockets } = createRealtime(provider)
    realtime.channel('events').subscribe()
    await flushPromises()
    sockets[0].open()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(sockets[0].close).toHaveBeenCalledTimes(1)
    expect(provider).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('renews 30 seconds before expiry and replaces the socket', async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce(access(40_000, 'token-1'))
      .mockResolvedValueOnce(access(120_000, 'token-2'))
    const { realtime, sockets } = createRealtime(provider)
    realtime.channel('events').subscribe()
    await flushPromises()
    sockets[0].open()
    sockets[0].message({ type: 'connection_ack' })

    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()

    expect(provider).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(2)
    expect(sockets[0].close).toHaveBeenCalledTimes(1)
  })

  it('uses capped exponential reconnect delays and resets after acknowledgment', async () => {
    const provider = vi.fn().mockImplementation(async () => access())
    const { realtime, sockets } = createRealtime(provider)
    realtime.channel('events').subscribe()
    await flushPromises()

    const delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
    for (let index = 0; index < delays.length; index++) {
      sockets[index].closed({ code: 1006 })
      await vi.advanceTimersByTimeAsync(delays[index])
      await flushPromises()
      expect(sockets).toHaveLength(index + 2)
    }

    sockets.at(-1)!.open()
    sockets.at(-1)!.message({ type: 'connection_ack' })
    sockets.at(-1)!.closed({ code: 1006 })
    await vi.advanceTimersByTimeAsync(999)
    expect(provider).toHaveBeenCalledTimes(delays.length + 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider).toHaveBeenCalledTimes(delays.length + 2)
  })

  it('halts on permanent token errors and lets an identity change re-arm the channel', async () => {
    const provider = vi.fn()
      .mockRejectedValueOnce(new RealtimeTokenRequestError({
        code: 'UNAUTHORIZED',
        message: 'invalid project token',
        retryable: false,
      }))
      .mockResolvedValueOnce(access())
    const { realtime, sockets } = createRealtime(provider)
    const statuses: Array<[RealtimeChannelStatus, string | undefined]> = []
    realtime.channel('events').subscribe((status, error) => statuses.push([status, error?.code]))
    await flushPromises()

    expect(statuses.at(-1)).toEqual(['CHANNEL_ERROR', 'UNAUTHORIZED'])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(provider).toHaveBeenCalledTimes(1)

    realtime.handleIdentityChange()
    await flushPromises()
    expect(provider).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(1)
  })

  it('retries retryable token errors and respects Retry-After', async () => {
    const provider = vi.fn()
      .mockRejectedValueOnce(new RealtimeTokenRequestError({
        code: 'RATE_LIMITED',
        message: 'limited',
        retryable: true,
        retryAfterMs: 5_000,
      }))
      .mockResolvedValueOnce(access())
    const { realtime } = createRealtime(provider)
    realtime.channel('events').subscribe()
    await flushPromises()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(provider).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('treats operation errors and auth close codes as permanent', async () => {
    const provider = vi.fn().mockResolvedValue(access())
    const first = createRealtime(provider)
    const statuses: RealtimeChannelStatus[] = []
    first.realtime.channel('events').subscribe((status) => statuses.push(status))
    await flushPromises()
    first.sockets[0].open()
    first.sockets[0].message({ type: 'connection_ack' })
    first.sockets[0].message({ type: 'error', payload: [{ message: 'permission denied' }] })

    expect(first.sockets[0].close).toHaveBeenCalled()
    expect(statuses.at(-1)).toBe('CHANNEL_ERROR')
    expect(vi.getTimerCount()).toBe(0)

    const second = createRealtime(vi.fn().mockResolvedValue(access()))
    second.realtime.channel('events').subscribe()
    await flushPromises()
    second.sockets[0].closed({ code: 4401, reason: 'Unauthorized' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes an old-identity socket before exchanging its replacement', async () => {
    let resolveSecond!: (value: RealtimeAccessToken) => void
    const provider = vi.fn()
      .mockResolvedValueOnce(access(120_000, 'old-token'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const { realtime, sockets } = createRealtime(provider)
    realtime.channel('events').subscribe()
    await flushPromises()
    sockets[0].open()
    sockets[0].message({ type: 'connection_ack' })

    realtime.handleIdentityChange()
    expect(sockets[0].close).toHaveBeenCalledTimes(1)
    expect(provider).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(1)

    resolveSecond(access(120_000, 'new-token'))
    await flushPromises()
    expect(sockets).toHaveLength(2)
  })

  it('keeps handlers across unsubscribe/resubscribe and permanently disposes removed channels', async () => {
    const provider = vi.fn().mockResolvedValue(access())
    const { realtime, sockets } = createRealtime(provider)
    const callback = vi.fn()
    const statuses: RealtimeChannelStatus[] = []
    const channel = realtime.channel('events')
      .on('postgres_changes', { event: '*', table: 'events' }, callback)
    const first = channel.subscribe((status) => statuses.push(status))
    await flushPromises()
    first.unsubscribe()
    first.unsubscribe()

    expect(sockets[0].close).toHaveBeenCalledTimes(1)
    expect(statuses.filter((status) => status === 'CLOSED')).toHaveLength(1)

    channel.subscribe()
    await flushPromises()
    expect(provider).toHaveBeenCalledTimes(2)
    expect(() => channel.subscribe()).toThrow('already active')

    realtime.removeChannel(channel)
    expect(sockets[1].close).toHaveBeenCalledTimes(1)
    expect(() => channel.subscribe()).toThrow('removed')
  })

  it('ignores stale callbacks and treats the first reconnect result as a snapshot', async () => {
    const provider = vi.fn().mockResolvedValue(access())
    const { realtime, sockets } = createRealtime(provider)
    const callback = vi.fn()
    realtime.channel('events')
      .on('postgres_changes', { event: '*', table: 'events' }, callback)
      .subscribe()
    await flushPromises()
    sockets[0].open()
    sockets[0].message({ type: 'connection_ack' })
    sockets[0].message({ type: 'next', payload: { data: { events: [{ id: 1 }] } } })
    sockets[0].closed({ code: 1006 })
    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    sockets[1].open()
    sockets[1].message({ type: 'connection_ack' })

    sockets[0].message({ type: 'next', payload: { data: { events: [{ id: 1 }, { id: 99 }] } } })
    sockets[1].message({ type: 'next', payload: { data: { events: [{ id: 1 }, { id: 2 }] } } })
    expect(callback).not.toHaveBeenCalled()
    sockets[1].message({ type: 'next', payload: { data: { events: [{ id: 1 }, { id: 2 }, { id: 3 }] } } })
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('maintains JSON snapshots when structuredClone is unavailable', async () => {
    vi.stubGlobal('structuredClone', undefined)
    const provider = vi.fn().mockResolvedValue(access())
    const { realtime, sockets } = createRealtime(provider)
    const callback = vi.fn()
    realtime.channel('events')
      .on('postgres_changes', { event: '*', table: 'events' }, callback)
      .subscribe()
    await flushPromises()
    sockets[0].open()
    sockets[0].message({ type: 'connection_ack' })

    expect(() => sockets[0].message({
      type: 'next',
      payload: { data: { events: [{ id: 1, details: { label: 'before' } }] } },
    })).not.toThrow()
    expect(() => sockets[0].message({
      type: 'next',
      payload: {
        data: {
          events: [
            { id: 1, details: { label: 'after' } },
            { id: 2, details: { label: 'created' } },
          ],
        },
      },
    })).not.toThrow()

    expect(callback.mock.calls.map(([event]) => event)).toEqual([
      {
        eventType: 'INSERT',
        new: { id: 2, details: { label: 'created' } },
        old: null,
      },
      {
        eventType: 'UPDATE',
        new: { id: 1, details: { label: 'after' } },
        old: { id: 1, details: { label: 'before' } },
      },
    ])
  })

  it('closes an expiring socket when a temporary renewal cannot finish in time', async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce(access(40_000))
      .mockRejectedValueOnce(new RealtimeTokenRequestError({
        code: 'NETWORK_ERROR',
        message: 'temporary',
        retryable: true,
        retryAfterMs: 60_000,
      }))
    const { realtime, sockets } = createRealtime(provider)
    realtime.channel('events').subscribe()
    await flushPromises()
    sockets[0].open()
    sockets[0].message({ type: 'connection_ack' })

    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()
    expect(sockets[0].close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sockets[0].close).toHaveBeenCalledTimes(1)
  })
})
