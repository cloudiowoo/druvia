import { describe, it, expect, vi } from 'vitest'
import { createClient } from '../../packages/sdk/src/index.js'
import type { WebSocketLike } from '../../packages/sdk/src/types.js'

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

  it('graphql() prefers the project session token over the platform session token', async () => {
    const store = new Map<string, string>([
      ['druvia.session', JSON.stringify({ accessToken: 'platform-token', user: { id: 1 } })],
      ['druvia.project_session:proj_123', JSON.stringify({ accessToken: 'project-token', user: { id: 'usr_proj_1' } })],
    ])
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { __typename: 'query_root' }, error: null }),
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

    await client.graphql('query { __typename }')

    const headers = new Headers((fetch as any).mock.calls[0][1].headers)
    expect(headers.get('Authorization')).toBe('Bearer project-token')
    expect(headers.get('apikey')).toBe('test-key')
  })

  it('graphql() does not fall back to the platform session token', async () => {
    const store = new Map<string, string>([
      ['druvia.session', JSON.stringify({ accessToken: 'platform-token', user: { id: 1 } })],
    ])
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { __typename: 'query_root' }, error: null }),
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

    await client.graphql('query { __typename }')

    const headers = new Headers((fetch as any).mock.calls[0][1].headers)
    expect(headers.get('Authorization')).toBeNull()
    expect(headers.get('apikey')).toBe('test-key')
  })

  it('rpc() keeps the platform fallback when no project session exists', async () => {
    const store = new Map<string, string>([
      ['druvia.session', JSON.stringify({ accessToken: 'platform-token', user: { id: 1 } })],
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

    await client.rpc('test_fn')

    const headers = new Headers((fetch as any).mock.calls[0][1].headers)
    expect(headers.get('Authorization')).toBe('Bearer platform-token')
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

  it.each([
    {
      name: 'project session takes precedence over platform session',
      sessions: [
        ['druvia.session', { accessToken: 'platform-token', user: { id: 1 } }],
        ['druvia.project_session:proj_123', { accessToken: 'project-token', user: { id: 'pusr_1' } }],
      ],
      expectedAuthorization: 'Bearer project-token',
    },
    {
      name: 'platform-only session is not used for Realtime',
      sessions: [
        ['druvia.session', { accessToken: 'platform-token', user: { id: 1 } }],
      ],
      expectedAuthorization: null,
    },
  ])('$name', async ({ sessions, expectedAuthorization }) => {
    const store = new Map(sessions.map(([key, value]) => [String(key), JSON.stringify(value)]))
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        success: true,
        data: {
          token: 'realtime-token',
          expiresIn: 300,
          expiresAt: '2099-08-18T10:05:00.000Z',
          websocketUrl: 'wss://druvia.example.com/v1/graphql',
        },
      }),
    })
    const storage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { store.set(key, value) }),
      removeItem: vi.fn((key: string) => { store.delete(key) }),
    }
    const websocket = vi.fn().mockReturnValue({
      onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
      send: vi.fn(), close: vi.fn(),
    })
    const client = createClient('http://localhost:3001/api/v1', 'test-key', {
      projectId: 'proj_123',
      fetch: fetch as never,
      storage,
      websocket,
    })

    client.channel('events').subscribe()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    expect(fetch.mock.calls[0][0]).toBe(
      'http://localhost:3001/api/v1/projects/proj_123/realtime/token'
    )
    const headers = new Headers(fetch.mock.calls[0][1].headers)
    expect(headers.get('Authorization')).toBe(expectedAuthorization)
    expect(headers.get('apikey')).toBe('test-key')
  })

  it('loads an async persisted Project Session before Realtime token exchange', async () => {
    const store = new Map([
      ['druvia.project_session:proj_123', JSON.stringify({
        accessToken: 'async-project-token',
        user: { id: 'pusr_async' },
      })],
    ])
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        success: true,
        data: {
          token: 'realtime-token',
          expiresIn: 300,
          expiresAt: '2099-08-18T10:05:00.000Z',
          websocketUrl: 'wss://druvia.example.com/v1/graphql',
        },
      }),
    })
    const storage = {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
      removeItem: vi.fn(async (key: string) => { store.delete(key) }),
    }
    const client = createClient('http://localhost:3001/api/v1', 'test-key', {
      projectId: 'proj_123',
      fetch: fetch as never,
      storage,
      websocket: vi.fn().mockReturnValue({
        onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
        send: vi.fn(), close: vi.fn(),
      }),
    })

    client.channel('events').subscribe()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    expect(new Headers(fetch.mock.calls[0][1].headers).get('Authorization')).toBe(
      'Bearer async-project-token'
    )
  })

  it('does not downgrade an invalid selected project session to API-key-only retry', async () => {
    vi.useFakeTimers()
    const store = new Map([
      ['druvia.project_session:proj_123', JSON.stringify({
        accessToken: 'invalid-project-token',
        user: { id: 'pusr_1' },
      })],
    ])
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'invalid token' },
      }),
    })
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    }
    const statuses: string[] = []
    const client = createClient('http://localhost:3001/api/v1', 'test-key', {
      projectId: 'proj_123',
      fetch: fetch as never,
      storage,
      websocket: vi.fn(),
    })

    client.channel('events').subscribe((status) => statuses.push(status))
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(new Headers(fetch.mock.calls[0][1].headers).get('Authorization')).toBe(
      'Bearer invalid-project-token'
    )
    expect(statuses.at(-1)).toBe('CHANNEL_ERROR')
    vi.useRealTimers()
  })

  it('closes the active socket before exchanging with a refreshed Project identity', async () => {
    const store = new Map([
      ['druvia.project_session:proj_123', JSON.stringify({
        accessToken: 'old-project-token',
        refreshToken: 'refresh-token',
        user: { id: 'pusr_1' },
      })],
    ])
    const sockets: Array<WebSocketLike & { close: ReturnType<typeof vi.fn> }> = []
    const websocket = vi.fn(() => {
      const socket = {
        onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
        send: vi.fn(), close: vi.fn(),
      }
      sockets.push(socket)
      return socket
    })
    const tokenHeaders: Array<Headers> = []
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            data: {
              token: 'new-project-token',
              refreshToken: 'new-refresh-token',
              expiresIn: 3600,
              expiresAt: '2099-08-18T11:00:00.000Z',
              user: { id: 'pusr_1' },
            },
          }),
        } as Response
      }
      tokenHeaders.push(new Headers(init?.headers))
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          success: true,
          data: {
            token: `realtime-token-${tokenHeaders.length}`,
            expiresIn: 300,
            expiresAt: '2099-08-18T10:05:00.000Z',
            websocketUrl: 'wss://druvia.example.com/v1/graphql',
          },
        }),
      } as Response
    })
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    }
    const client = createClient('http://localhost:3001/api/v1', 'test-key', {
      projectId: 'proj_123', fetch: fetch as never, storage, websocket,
    })
    client.channel('events').subscribe()
    await vi.waitFor(() => expect(tokenHeaders).toHaveLength(1))
    expect(tokenHeaders[0].get('Authorization')).toBe('Bearer old-project-token')

    await client.projectAuth.refreshSession({ refresh_token: 'refresh-token' })
    expect(sockets[0].close).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(tokenHeaders).toHaveLength(2))
    expect(tokenHeaders[1].get('Authorization')).toBe('Bearer new-project-token')
  })
})
