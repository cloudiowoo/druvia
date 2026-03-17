import { describe, it, expect, vi } from 'vitest'
import { DruviaAuth } from '../../packages/sdk/src/modules/auth.js'
import type { FetchFn, StorageAdapter } from '../../packages/sdk/src/types.js'

function createMockFetch(responseData: unknown, status = 200): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseData,
  } as Response)
}

function createMockStorage(): StorageAdapter {
  const store = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { store.set(key, value) }),
    removeItem: vi.fn((key: string) => { store.delete(key) }),
  }
}

describe('DruviaAuth', () => {
  it('signUp calls register endpoint', async () => {
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.signUp({ email: 'a@b.com', password: '12345678' })
    expect(result.error).toBeNull()
    expect(result.data?.user.email).toBe('a@b.com')
    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/register', expect.objectContaining({ method: 'POST' }))
  })

  it('signIn with email calls login endpoint', async () => {
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.signIn({ email: 'a@b.com', password: '12345678' })
    expect(result.error).toBeNull()
    expect(storage.setItem).toHaveBeenCalled()
  })

  it('signIn with username calls login endpoint', async () => {
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, username: 'admin' }, token: 'tok123' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.signIn({ username: 'admin', password: '12345678' })
    expect(result.error).toBeNull()
  })

  it('signOut clears stored session', async () => {
    const storage = createMockStorage()
    await storage.setItem('druvia.session', JSON.stringify({ accessToken: 'tok', user: { id: 1 } }))
    const fetch = createMockFetch({})
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    await auth.signOut()
    expect(storage.removeItem).toHaveBeenCalledWith('druvia.session')
  })

  it('getUser returns current user', async () => {
    const fetch = createMockFetch({ success: true, data: { id: 1, email: 'a@b.com', username: 'admin', role: 'admin' } })
    const storage = createMockStorage()
    await storage.setItem('druvia.session', JSON.stringify({ accessToken: 'tok', user: { id: 1 } }))
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.getUser()
    expect(result.data).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith('/api/v1/users/me', expect.objectContaining({ method: 'GET' }))
  })

  it('getSession returns null when no session stored', async () => {
    const fetch = createMockFetch({})
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.getSession()
    expect(result.data).toBeNull()
  })

  it('handles login failure', async () => {
    const fetch = createMockFetch({ success: false, error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } }, 401)
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.signIn({ email: 'a@b.com', password: 'wrong' })
    expect(result.data).toBeNull()
    expect(result.error?.code).toBe('AUTH_FAILED')
  })

  it('onAuthStateChange fires on signIn and signOut', async () => {
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const callback = vi.fn()
    const { unsubscribe } = auth.onAuthStateChange(callback)

    await auth.signIn({ email: 'a@b.com', password: '12345678' })
    expect(callback).toHaveBeenCalledWith('SIGNED_IN', expect.objectContaining({ accessToken: 'tok123' }))

    await auth.signOut()
    expect(callback).toHaveBeenCalledWith('SIGNED_OUT', null)

    callback.mockClear()
    unsubscribe()
    await auth.signOut()
    expect(callback).not.toHaveBeenCalled()
  })
})