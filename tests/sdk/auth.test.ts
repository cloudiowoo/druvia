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
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123', refreshToken: 'ref123' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.signUp({ email: 'a@b.com', password: '12345678' })
    expect(result.error).toBeNull()
    expect(result.data?.user.email).toBe('a@b.com')
    expect(result.data?.refreshToken).toBe('ref123')
    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/register', expect.objectContaining({ method: 'POST' }))
  })

  it('signIn with email calls login endpoint', async () => {
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123', refreshToken: 'ref456' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.signIn({ email: 'a@b.com', password: '12345678' })
    expect(result.error).toBeNull()
    expect(result.data?.refreshToken).toBe('ref456')
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

  it('getUser returns { data: { user } } structure', async () => {
    const fetch = createMockFetch({ success: true, data: { id: 1, email: 'a@b.com', username: 'admin', role: 'admin' } })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.getUser()
    expect(result.data.user).toBeTruthy()
    expect(result.data.user?.email).toBe('a@b.com')
    expect(result.error).toBeNull()
  })

  it('getSession returns { data: { session: null } } when no session stored', async () => {
    const fetch = createMockFetch({})
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.getSession()
    expect(result.data.session).toBeNull()
    expect(result.error).toBeNull()
  })

  it('getSession returns { data: { session } } when session exists', async () => {
    const fetch = createMockFetch({})
    const storage = createMockStorage()
    const session = { accessToken: 'tok', user: { id: 1, email: 'a@b.com' } }
    await storage.setItem('druvia.session', JSON.stringify(session))
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.getSession()
    expect(result.data.session).toEqual(session)
    expect(result.data.session?.accessToken).toBe('tok')
  })

  it('handles login failure', async () => {
    const fetch = createMockFetch({ success: false, error: { code: 'AUTH_FAILED', message: 'Invalid credentials' } }, 401)
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.signIn({ email: 'a@b.com', password: 'wrong' })
    expect(result.data).toBeNull()
    expect(result.error?.code).toBe('AUTH_FAILED')
  })

  it('updateUser calls PATCH /users/me', async () => {
    const updatedUser = { id: 1, email: 'a@b.com', username: 'newname', avatarUrl: 'https://img.com/a.png' }
    const fetch = createMockFetch({ success: true, data: updatedUser })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.updateUser({ data: { username: 'newname', avatar_url: 'https://img.com/a.png' } })
    expect(result.data.user?.username).toBe('newname')
    expect(result.error).toBeNull()
    expect(fetch).toHaveBeenCalledWith('/api/v1/users/me', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ username: 'newname', avatarUrl: 'https://img.com/a.png' }),
    }))
  })

  it('updateUser handles error', async () => {
    const fetch = createMockFetch({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }, 401)
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.updateUser({ data: { username: 'x' } })
    expect(result.data.user).toBeNull()
    expect(result.error?.code).toBe('UNAUTHORIZED')
  })

  it('onAuthStateChange fires on signIn and signOut', async () => {
    const fetch = createMockFetch({ success: true, data: { user: { id: 1, email: 'a@b.com' }, token: 'tok123', refreshToken: 'ref789' } })
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

  it('refreshSession exchanges refresh_token for new session', async () => {
    const newSession = {
      user: { id: 1, email: 'a@b.com' },
      token: 'new-access-tok',
      refreshToken: 'new-refresh-tok',
    }
    const fetch = createMockFetch({ success: true, data: newSession })
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.refreshSession({ refresh_token: 'old-refresh-tok' })
    expect(result.data?.session?.accessToken).toBe('new-access-tok')
    expect(result.data?.session?.refreshToken).toBe('new-refresh-tok')
    expect(result.error).toBeNull()
    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/refresh', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ refresh_token: 'old-refresh-tok' }),
    }))
    // Verify session saved with refreshToken
    const savedSession = JSON.parse((storage.setItem as ReturnType<typeof vi.fn>).mock.calls[0][1])
    expect(savedSession.refreshToken).toBe('new-refresh-tok')
  })

  it('refreshSession handles invalid token', async () => {
    const fetch = createMockFetch(
      { success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired refresh token' } },
      401
    )
    const storage = createMockStorage()
    const auth = new DruviaAuth('/api/v1', fetch, storage)
    const result = await auth.refreshSession({ refresh_token: 'bad-token' })
    expect(result.data.session).toBeNull()
    expect(result.error?.code).toBe('INVALID_TOKEN')
  })
})