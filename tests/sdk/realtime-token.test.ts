import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RealtimeTokenRequestError,
  createRealtimeTokenProvider,
} from '../../packages/sdk/src/modules/realtime-token.js'
import type { FetchFn } from '../../packages/sdk/src/types.js'
import { createHttpOnlyUrlConstructor } from './http-only-url-runtime.js'

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response
}

function createProvider(fetchFn: FetchFn) {
  return createRealtimeTokenProvider({
    apiBase: 'http://localhost:3001/api/v1/',
    projectId: 'proj_123',
    fetchFn,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Realtime token provider', () => {
  it('posts without a body and returns a validated token envelope', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      success: true,
      data: {
        token: 'signed-token',
        expiresIn: 300,
        expiresAt: '2099-08-18T10:05:00.000Z',
        websocketUrl: 'wss://druvia.example.com/v1/graphql',
      },
    })) as unknown as FetchFn

    await expect(createProvider(fetchFn)()).resolves.toEqual({
      token: 'signed-token',
      expiresIn: 300,
      expiresAt: '2099-08-18T10:05:00.000Z',
      websocketUrl: 'wss://druvia.example.com/v1/graphql',
    })
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/projects/proj_123/realtime/token',
      { method: 'POST' }
    )
  })

  it('accepts a WebSocket URL when the runtime URL implementation only supports HTTP(S)', async () => {
    vi.stubGlobal('URL', createHttpOnlyUrlConstructor(globalThis.URL))
    const fetchFn = vi.fn().mockResolvedValue(response({
      success: true,
      data: {
        token: 'signed-token',
        expiresIn: 300,
        expiresAt: '2099-08-18T10:05:00.000Z',
        websocketUrl: 'wss://druvia.example.com/v1/graphql',
      },
    })) as unknown as FetchFn

    await expect(createProvider(fetchFn)()).resolves.toMatchObject({
      websocketUrl: 'wss://druvia.example.com/v1/graphql',
    })
  })

  it('preserves the validated WebSocket URL returned by the API', async () => {
    const websocketUrl = ' \nWSS://Example.COM:443/custom/\t'
    const fetchFn = vi.fn().mockResolvedValue(response({
      success: true,
      data: {
        token: 'signed-token',
        expiresIn: 300,
        expiresAt: '2099-08-18T10:05:00.000Z',
        websocketUrl,
      },
    })) as unknown as FetchFn

    await expect(createProvider(fetchFn)()).resolves.toMatchObject({ websocketUrl })
  })

  it.each([
    'wss://user:pass@druvia.example.com/v1/graphql',
    'wss://druvia.example.com/v1/graphql?token=secret',
    'wss://druvia.example.com/v1/graphql#fragment',
  ])('rejects an unsafe WebSocket URL with an HTTP-only runtime: %s', async (websocketUrl) => {
    vi.stubGlobal('URL', createHttpOnlyUrlConstructor(globalThis.URL))
    const fetchFn = vi.fn().mockResolvedValue(response({
      success: true,
      data: {
        token: 'signed-token',
        expiresIn: 300,
        expiresAt: '2099-08-18T10:05:00.000Z',
        websocketUrl,
      },
    })) as unknown as FetchFn

    await expect(createProvider(fetchFn)()).rejects.toMatchObject({
      code: 'REALTIME_TOKEN_RESPONSE_INVALID',
      retryable: false,
    })
  })

  it.each([
    { token: '', expiresIn: 300, expiresAt: '2099-08-18T10:05:00.000Z', websocketUrl: 'wss://example.com/v1/graphql' },
    { token: 'token', expiresIn: 0, expiresAt: '2099-08-18T10:05:00.000Z', websocketUrl: 'wss://example.com/v1/graphql' },
    { token: 'token', expiresIn: 300, expiresAt: 'invalid', websocketUrl: 'wss://example.com/v1/graphql' },
    { token: 'token', expiresIn: 300, expiresAt: '2020-01-01T00:00:00.000Z', websocketUrl: 'wss://example.com/v1/graphql' },
    { token: 'token', expiresIn: 300, expiresAt: '2099-08-18T10:05:00.000Z', websocketUrl: 'https://example.com/v1/graphql' },
    { token: 'token', expiresIn: 300, expiresAt: '2099-08-18T10:05:00.000Z', websocketUrl: 'wss://user:pass@example.com/v1/graphql' },
    { token: 'token', expiresIn: 300, expiresAt: '2099-08-18T10:05:00.000Z', websocketUrl: 'wss://example.com/v1/graphql?token=secret' },
  ])('rejects malformed success data as permanent', async (data) => {
    const provider = createProvider(vi.fn().mockResolvedValue(response({ success: true, data })) as never)

    await expect(provider()).rejects.toMatchObject({
      code: 'REALTIME_TOKEN_RESPONSE_INVALID',
      retryable: false,
    })
  })

  it('rejects malformed JSON as a permanent response error', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: vi.fn().mockRejectedValue(new SyntaxError('private response body')),
    }) as unknown as FetchFn

    await expect(createProvider(fetchFn)()).rejects.toMatchObject({
      code: 'REALTIME_TOKEN_RESPONSE_INVALID',
      retryable: false,
    })
  })

  it.each([400, 401, 403, 404])('classifies HTTP %s as permanent', async (status) => {
    const provider = createProvider(vi.fn().mockResolvedValue(response({
      success: false,
      error: { code: `HTTP_${status}`, message: 'credential rejected' },
    }, status)) as never)

    await expect(provider()).rejects.toMatchObject({
      code: `HTTP_${status}`,
      retryable: false,
    })
  })

  it('classifies 429 as retryable and parses numeric Retry-After', async () => {
    const provider = createProvider(vi.fn().mockResolvedValue(response({
      success: false,
      error: { code: 'REALTIME_TOKEN_RATE_LIMIT_EXCEEDED', message: 'limited' },
    }, 429, { 'Retry-After': '12' })) as never)

    await expect(provider()).rejects.toMatchObject({
      code: 'REALTIME_TOKEN_RATE_LIMIT_EXCEEDED',
      retryable: true,
      retryAfterMs: 12_000,
    })
  })

  it('parses an HTTP-date Retry-After relative to the current clock', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-18T10:00:00.000Z'))
    const provider = createProvider(vi.fn().mockResolvedValue(response({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'limited' },
    }, 429, { 'Retry-After': 'Tue, 18 Aug 2026 10:00:09 GMT' })) as never)

    await expect(provider()).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 9_000,
    })
  })

  it('classifies server errors as retryable', async () => {
    const provider = createProvider(vi.fn().mockResolvedValue(response({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'failed' },
    }, 500)) as never)

    await expect(provider()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: true,
    })
  })

  it('classifies network errors as retryable without exposing the cause', async () => {
    const privateMessage = 'request failed for apikey=private-value'
    const provider = createProvider(vi.fn().mockRejectedValue(new Error(privateMessage)) as never)

    try {
      await provider()
      throw new Error('expected provider to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(RealtimeTokenRequestError)
      expect(error).toMatchObject({
        code: 'REALTIME_TOKEN_NETWORK_ERROR',
        retryable: true,
      })
      expect((error as Error).message).not.toContain(privateMessage)
    }
  })
})
