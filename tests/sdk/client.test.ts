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
    expect(client.projectAuth).toBeDefined()
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

  it('rpc() prefers the project session token over the platform session token', async () => {
    const store = new Map<string, string>([
      ['druvia.session', JSON.stringify({ accessToken: 'platform-token', user: { id: 1 } })],
      ['druvia.project_session', JSON.stringify({ accessToken: 'project-token', user: { id: 'usr_proj_1' } })],
    ])
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { ok: true }, error: null }),
    })
    const storage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { store.set(key, value) }),
      removeItem: vi.fn((key: string) => { store.delete(key) }),
    }

    const client = createClient('http://localhost:3001/api/v1', 'test-key', {
      projectId: 'proj_123',
      fetch: fetch as any,
      storage,
    })

    await client.rpc('test_fn', { arg: 1 })

    const headers = new Headers((fetch as any).mock.calls[0][1].headers)
    expect(headers.get('Authorization')).toBe('Bearer project-token')
    expect(headers.get('apikey')).toBe('test-key')
  })

  it('functions() falls back to the platform token when no project session exists', async () => {
    const store = new Map<string, string>([
      ['druvia.session', JSON.stringify({ accessToken: 'platform-token', user: { id: 1 } })],
    ])
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { ok: true } }),
    })
    const storage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { store.set(key, value) }),
      removeItem: vi.fn((key: string) => { store.delete(key) }),
    }

    const client = createClient('http://localhost:3001/api/v1', 'test-key', {
      projectId: 'proj_123',
      fetch: fetch as any,
      storage,
    })

    await client.functions.invoke('upload-avatar', { body: { fileName: 'avatar.png' } })

    const headers = new Headers((fetch as any).mock.calls[0][1].headers)
    expect(headers.get('Authorization')).toBe('Bearer platform-token')
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
