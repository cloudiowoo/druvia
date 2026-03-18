import type { FetchFn } from '../types.js'

/** Default fetch — uses globalThis.fetch */
export function getDefaultFetch(): FetchFn {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis)
  }
  throw new Error('@druvia/sdk: No fetch implementation found. Pass a custom fetch in createClient options.')
}

/** Wrapper that adds auth headers and base URL */
export function createFetchWrapper(
  baseUrl: string,
  apiKey: string,
  fetchFn: FetchFn,
  getToken: () => string | null,
): FetchFn {
  return async (input: string, init?: RequestInit) => {
    const url = input.startsWith('http') ? input : `${baseUrl}${input}`
    const headers = new Headers(init?.headers)
    headers.set('apikey', apiKey)
    const token = getToken()
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    if (!headers.has('Content-Type') && init?.body) {
      headers.set('Content-Type', 'application/json')
    }
    return fetchFn(url, { ...init, headers })
  }
}
