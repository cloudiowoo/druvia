import type { StorageAdapter } from '../types.js'

/** Default storage — uses globalThis.localStorage, no-op if unavailable */
export function getDefaultStorage(): StorageAdapter {
  if (typeof globalThis.localStorage !== 'undefined' && typeof globalThis.localStorage?.getItem === 'function') {
    return globalThis.localStorage
  }
  // In-memory fallback (Node.js, SSR)
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value) },
    removeItem: (key) => { store.delete(key) },
  }
}
