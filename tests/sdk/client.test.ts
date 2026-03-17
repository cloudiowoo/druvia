import { describe, it, expect, vi } from 'vitest'
import { createClient } from '../../packages/sdk/src/index.js'

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ data: {} }),
} as Response)
globalThis.fetch = mockFetch as any

describe('createClient', () => {
  it('creates a client with required options', () => {
    const client = createClient('http://localhost:3001', 'test-api-key', {
      projectId: 'proj_123',
    })
    expect(client).toBeDefined()
    expect(client.auth).toBeDefined()
    expect(client.storage).toBeDefined()
    expect(client.functions).toBeDefined()
    expect(typeof client.from).toBe('function')
    expect(typeof client.rpc).toBe('function')
    expect(typeof client.graphql).toBe('function')
  })

  it('from() returns a QueryBuilder', () => {
    const client = createClient('http://localhost:3001', 'test-key', {
      projectId: 'proj_123',
    })
    const qb = client.from('users')
    expect(typeof qb.select).toBe('function')
    expect(typeof qb.insert).toBe('function')
    expect(typeof qb.eq).toBe('function')
  })

  it('rpc() delegates to DruviaRpc', async () => {
    const client = createClient('http://localhost:3001', 'test-key', {
      projectId: 'proj_123',
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { result: true } }),
      }) as any,
    })
    const result = await client.rpc('test_fn', { arg: 1 })
    expect(result).toBeDefined()
  })

  it('channel() returns a RealtimeChannel when websocket provided', () => {
    const client = createClient('http://localhost:3001', 'test-key', {
      projectId: 'proj_123',
      websocket: vi.fn().mockReturnValue({
        onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
        send: vi.fn(), close: vi.fn(),
      }),
    })
    const ch = client.channel('test')
    expect(ch).toBeDefined()
    expect(typeof ch.on).toBe('function')
  })

  it('channel() throws when no websocket available', () => {
    const origWs = globalThis.WebSocket
    delete (globalThis as any).WebSocket

    const client = createClient('http://localhost:3001', 'test-key', {
      projectId: 'proj_123',
    })
    expect(() => client.channel('test')).toThrow('@druvia/sdk: No WebSocket available')

    ;(globalThis as any).WebSocket = origWs
  })
})
