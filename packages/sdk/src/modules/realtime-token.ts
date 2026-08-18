import type { FetchFn } from '../types.js'

export interface RealtimeAccessToken {
  token: string
  expiresIn: number
  expiresAt: string
  websocketUrl: string
}

export type RealtimeTokenProvider = () => Promise<RealtimeAccessToken>

export class RealtimeTokenRequestError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(input: {
    code: string
    message: string
    retryable: boolean
    retryAfterMs?: number
  }) {
    super(input.message)
    this.name = 'RealtimeTokenRequestError'
    this.code = input.code
    this.retryable = input.retryable
    this.retryAfterMs = input.retryAfterMs
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }

  const date = Date.parse(value)
  if (!Number.isFinite(date)) return undefined
  return Math.max(0, date - Date.now())
}

function isValidWebsocketUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false

  try {
    const url = new URL(value)
    return (url.protocol === 'ws:' || url.protocol === 'wss:')
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
  } catch {
    return false
  }
}

function parseAccessToken(value: unknown): RealtimeAccessToken | null {
  if (!value || typeof value !== 'object') return null
  const envelope = value as { success?: unknown; data?: unknown }
  if (envelope.success !== true || !envelope.data || typeof envelope.data !== 'object') {
    return null
  }

  const data = envelope.data as Partial<RealtimeAccessToken>
  const expiresAtMs = typeof data.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN
  if (
    typeof data.token !== 'string'
    || data.token.length === 0
    || typeof data.expiresIn !== 'number'
    || !Number.isFinite(data.expiresIn)
    || data.expiresIn <= 0
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= Date.now()
    || !isValidWebsocketUrl(data.websocketUrl)
  ) {
    return null
  }

  return {
    token: data.token,
    expiresIn: data.expiresIn,
    expiresAt: data.expiresAt as string,
    websocketUrl: data.websocketUrl,
  }
}

function readErrorEnvelope(value: unknown, status: number): { code: string; message: string } {
  if (value && typeof value === 'object') {
    const error = (value as { error?: unknown }).error
    if (error && typeof error === 'object') {
      const candidate = error as { code?: unknown; message?: unknown }
      if (typeof candidate.code === 'string' && candidate.code.length > 0) {
        return {
          code: candidate.code,
          message: typeof candidate.message === 'string'
            ? candidate.message
            : 'Realtime token request failed',
        }
      }
    }
  }

  return {
    code: `REALTIME_TOKEN_HTTP_${status}`,
    message: 'Realtime token request failed',
  }
}

export function createRealtimeTokenProvider(input: {
  apiBase: string
  projectId: string
  fetchFn: FetchFn
}): RealtimeTokenProvider {
  const apiBase = input.apiBase.replace(/\/+$/, '')
  const endpoint = `${apiBase}/projects/${encodeURIComponent(input.projectId)}/realtime/token`

  return async () => {
    let response: Response
    try {
      response = await input.fetchFn(endpoint, { method: 'POST' })
    } catch {
      throw new RealtimeTokenRequestError({
        code: 'REALTIME_TOKEN_NETWORK_ERROR',
        message: 'Realtime token request failed due to a network error',
        retryable: true,
      })
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      if (response.ok) {
        throw new RealtimeTokenRequestError({
          code: 'REALTIME_TOKEN_RESPONSE_INVALID',
          message: 'Realtime token response is invalid',
          retryable: false,
        })
      }
    }

    if (!response.ok) {
      const error = readErrorEnvelope(body, response.status)
      const retryable = response.status === 429 || response.status >= 500
      throw new RealtimeTokenRequestError({
        ...error,
        retryable,
        ...(response.status === 429
          ? { retryAfterMs: parseRetryAfter(response.headers?.get('Retry-After') ?? null) }
          : {}),
      })
    }

    const access = parseAccessToken(body)
    if (!access) {
      throw new RealtimeTokenRequestError({
        code: 'REALTIME_TOKEN_RESPONSE_INVALID',
        message: 'Realtime token response is invalid',
        retryable: false,
      })
    }

    return access
  }
}
