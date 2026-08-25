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
    ['wss://127.0.0.1./base', 'wss://127.0.0.1/base/v1/graphql'],
    ['wss://xn--fsqu00a.xn--0zwm56d/base', 'wss://xn--fsqu00a.xn--0zwm56d/base/v1/graphql'],
    ['wss://example.com//v1/graphql', 'wss://example.com/v1/graphql'],
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
    'wss://:443/v1/graphql',
    'wss://example..com/v1/graphql',
    'wss://example.com:70000/v1/graphql',
    'wss://example.com:invalid/v1/graphql',
    'wss://[not-ipv6]/v1/graphql',
    'wss://例子.测试/v1/graphql',
    'wss://[192.168.0.1::]/v1/graphql',
    'wss://[1:2:192.0.2.1::]/v1/graphql',
    'wss://foo.1/v1/graphql',
    'wss://example.123/v1/graphql',
    'wss://0x100000000/v1/graphql',
    'wss://0x7f000001/v1/graphql',
    'wss://example.com/v1/graphql/./',
    'wss://example.com/base/%2e%2e/v1/graphql',
  ])('rejects %s', (input) => {
    if (useHttpOnlyRuntime) {
      vi.stubGlobal('URL', createHttpOnlyUrlConstructor(globalThis.URL))
    }

    expect(normalizeWebSocketUrl(input)).toBeNull()
  })
})

it('normalizes a WebSocket URL without a global URL implementation', () => {
  vi.stubGlobal('URL', undefined)

  expect(normalizeWebSocketUrl('wss://druvia.example.com/base')).toBe(
    'wss://druvia.example.com/base/v1/graphql'
  )
})

it('normalizes a WebSocket URL without global URL or Array.prototype.at', () => {
  const atDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'at')
  vi.stubGlobal('URL', undefined)
  Object.defineProperty(Array.prototype, 'at', {
    configurable: true,
    value: undefined,
  })

  try {
    expect(normalizeWebSocketUrl('wss://druvia.example.com/base')).toBe(
      'wss://druvia.example.com/base/v1/graphql'
    )
  } finally {
    if (atDescriptor) {
      Object.defineProperty(Array.prototype, 'at', atDescriptor)
    } else {
      Reflect.deleteProperty(Array.prototype, 'at')
    }
  }
})
