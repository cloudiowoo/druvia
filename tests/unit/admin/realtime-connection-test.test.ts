import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createGraphqlWsClient, disposeClient, optionsRef } = vi.hoisted(() => ({
  createGraphqlWsClient: vi.fn(),
  disposeClient: vi.fn(),
  optionsRef: { current: null as null | Record<string, unknown> },
}))

vi.mock('graphql-ws', () => ({
  createClient: createGraphqlWsClient,
}))

import { api } from '../../../apps/admin/src/lib/api.js'
import { startRealtimeConnectionTest } from '../../../apps/admin/src/lib/realtime-connection-test.js'

describe('Admin Realtime application credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.setToken('platform-admin-token')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: {
          token: 'signed-realtime-token',
          expiresIn: 300,
          expiresAt: '2099-08-18T10:05:00.000Z',
          websocketUrl: 'wss://druvia.example.com/v1/graphql',
        },
      }),
    }))
  })

  it.each([
    {
      credential: { kind: 'apikey' as const, value: 'project-api-key' },
      expected: { apikey: 'project-api-key', authorization: null },
    },
    {
      credential: { kind: 'project_token' as const, value: 'project-access-token' },
      expected: { apikey: null, authorization: 'Bearer project-access-token' },
    },
  ])('sends only the selected $credential.kind credential', async ({ credential, expected }) => {
    await api.issueRealtimeToken('proj_123', credential)

    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/projects/proj_123/realtime/token', {
      method: 'POST',
      headers: expect.any(Object),
    })
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('apikey')).toBe(expected.apikey)
    expect(headers.get('Authorization')).toBe(expected.authorization)
    expect(headers.get('Authorization')).not.toBe('Bearer platform-admin-token')
  })
})

describe('disposable Realtime connection probe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    optionsRef.current = null
    createGraphqlWsClient.mockImplementation((options) => {
      optionsRef.current = options
      return { dispose: disposeClient }
    })
  })

  it('starts one non-retrying authenticated graphql-ws connection', () => {
    const onState = vi.fn()

    startRealtimeConnectionTest({
      websocketUrl: 'wss://druvia.example.com/v1/graphql',
      token: 'signed-realtime-token',
      onState,
    })

    expect(createGraphqlWsClient).toHaveBeenCalledWith(expect.objectContaining({
      url: 'wss://druvia.example.com/v1/graphql',
      lazy: false,
      retryAttempts: 0,
      connectionAckWaitTimeout: 10_000,
      connectionParams: {
        headers: { Authorization: 'Bearer signed-realtime-token' },
      },
      on: expect.objectContaining({
        connected: expect.any(Function),
        closed: expect.any(Function),
        error: expect.any(Function),
      }),
    }))
    expect(onState).toHaveBeenCalledWith('connecting')

    const on = optionsRef.current?.on as Record<string, (...args: unknown[]) => void>
    on.connected()
    expect(onState).toHaveBeenLastCalledWith('connected')
  })

  it.each([
    { code: 4504, reason: 'ack timeout' },
    { code: 4401, reason: 'unauthorized' },
    { code: 4403, reason: 'forbidden' },
  ])('reports close code $code as failed', (event) => {
    const onState = vi.fn()
    startRealtimeConnectionTest({
      websocketUrl: 'wss://druvia.example.com/v1/graphql',
      token: 'signed-realtime-token',
      onState,
    })

    const on = optionsRef.current?.on as Record<string, (...args: unknown[]) => void>
    on.closed(event)
    expect(onState).toHaveBeenLastCalledWith('failed', expect.any(Error))
  })

  it('reports an expected normal close as disconnected', () => {
    const onState = vi.fn()
    startRealtimeConnectionTest({
      websocketUrl: 'wss://druvia.example.com/v1/graphql',
      token: 'signed-realtime-token',
      onState,
    })
    const on = optionsRef.current?.on as Record<string, (...args: unknown[]) => void>

    on.closed({ code: 1000, reason: 'normal' })
    expect(onState).toHaveBeenLastCalledWith('disconnected')
  })

  it('disposes once and ignores callbacks after disposal', () => {
    const onState = vi.fn()
    const probe = startRealtimeConnectionTest({
      websocketUrl: 'wss://druvia.example.com/v1/graphql',
      token: 'signed-realtime-token',
      onState,
    })
    const on = optionsRef.current?.on as Record<string, (...args: unknown[]) => void>

    probe.dispose()
    probe.dispose()
    on.connected()
    on.error(new Error('late failure'))

    expect(disposeClient).toHaveBeenCalledTimes(1)
    expect(onState).toHaveBeenCalledTimes(1)
  })
})
