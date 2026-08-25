import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeWebSocketUrl } from '../../packages/sdk/src/lib/websocket-url.js'
import { createHttpOnlyUrlConstructor } from './http-only-url-runtime.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each([
  ['standard URL runtime', false],
  ['HTTP-only URL runtime', true],
])('WebSocket URL normalization with %s', (_label, useHttpOnlyRuntime) => {
  it.each([
    ['ws://localhost:8080', 'ws://localhost:8080/v1/graphql'],
    ['wss://[::1]:8443/base', 'wss://[::1]:8443/base/v1/graphql'],
    ['WSS://Example.COM:443/custom/', 'wss://example.com/custom/v1/graphql'],
    ['wss://example.com/v1/graphql/', 'wss://example.com/v1/graphql'],
    [' \nwss://example.com/base\t', 'wss://example.com/base/v1/graphql'],
  ])('normalizes %s', (input, expected) => {
    if (useHttpOnlyRuntime) {
      vi.stubGlobal('URL', createHttpOnlyUrlConstructor(globalThis.URL))
    }

    expect(normalizeWebSocketUrl(input)).toBe(expected)
  })

  it.each([
    'https://example.com/v1/graphql',
    'wss://user:pass@example.com/v1/graphql',
    'wss://example.com/v1/graphql?token=secret',
    'wss://example.com/v1/graphql#fragment',
  ])('rejects %s', (input) => {
    if (useHttpOnlyRuntime) {
      vi.stubGlobal('URL', createHttpOnlyUrlConstructor(globalThis.URL))
    }

    expect(normalizeWebSocketUrl(input)).toBeNull()
  })
})
