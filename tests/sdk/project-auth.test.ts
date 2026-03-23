import { describe, it, expect, vi } from 'vitest'
import { DruviaProjectAuth } from '../../packages/sdk/src/modules/project-auth.js'
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

describe('DruviaProjectAuth', () => {
  const projectId = 'proj_123'
  const projectSessionKey = `druvia.project_session:${projectId}`

  it('wechatLogin stores session under project session key', async () => {
    const fetch = createMockFetch({
      success: true,
      data: {
        token: 'project-access-token',
        refreshToken: 'project-refresh-token',
        expiresIn: 3600,
        expiresAt: '2026-03-24T01:00:00.000Z',
        user: { id: 'usr_proj_1', email: 'user@example.com', role: 'authenticated' },
      },
    })
    const storage = createMockStorage()
    const auth = new DruviaProjectAuth('/api/v1', projectId, fetch, storage)

    const result = await auth.wechatLogin({ code: 'wx_code' })

    expect(result.error).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/auth/wechat/login`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'wx_code' }),
      })
    )
    expect(storage.setItem).toHaveBeenCalledWith(
      projectSessionKey,
      expect.any(String)
    )
  })

  it('getSession and getUser read from local project session storage', async () => {
    const fetch = createMockFetch({})
    const storage = createMockStorage()
    await storage.setItem(projectSessionKey, JSON.stringify({
      accessToken: 'project-access-token',
      refreshToken: 'project-refresh-token',
      user: { id: 'usr_proj_1', email: 'user@example.com', role: 'authenticated' },
      expiresIn: 3600,
      expiresAt: '2026-03-24T01:00:00.000Z',
    }))

    const auth = new DruviaProjectAuth('/api/v1', projectId, fetch, storage)
    const sessionResult = await auth.getSession()
    const userResult = await auth.getUser()

    expect(sessionResult.data.session?.accessToken).toBe('project-access-token')
    expect(userResult.data.user?.id).toBe('usr_proj_1')
  })

  it('refreshSession rotates project session', async () => {
    const fetch = createMockFetch({
      success: true,
      data: {
        token: 'new-project-access-token',
        refreshToken: 'new-project-refresh-token',
        expiresIn: 3600,
        expiresAt: '2026-03-24T02:00:00.000Z',
        user: { id: 'usr_proj_1', email: 'user@example.com', role: 'authenticated' },
      },
    })
    const storage = createMockStorage()
    const auth = new DruviaProjectAuth('/api/v1', projectId, fetch, storage)

    const result = await auth.refreshSession({ refresh_token: 'old-project-refresh-token' })

    expect(result.data.session?.refreshToken).toBe('new-project-refresh-token')
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/auth/refresh`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'old-project-refresh-token' }),
      })
    )
  })

  it('logout clears only project session storage', async () => {
    const fetch = createMockFetch({ success: true, data: { loggedOut: true } })
    const storage = createMockStorage()
    await storage.setItem(projectSessionKey, JSON.stringify({
      accessToken: 'project-access-token',
      user: { id: 'usr_proj_1' },
    }))

    const auth = new DruviaProjectAuth('/api/v1', projectId, fetch, storage)
    const result = await auth.logout()

    expect(result.error).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/auth/logout`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(storage.removeItem).toHaveBeenCalledWith(projectSessionKey)
  })

  it('supports generic provider login paths', async () => {
    const fetch = createMockFetch({
      success: true,
      data: {
        token: 'provider-access-token',
        refreshToken: 'provider-refresh-token',
        expiresIn: 3600,
        expiresAt: '2026-03-24T01:00:00.000Z',
        user: { id: 'usr_proj_1', email: 'user@example.com', role: 'authenticated' },
      },
    })
    const storage = createMockStorage()
    const auth = new DruviaProjectAuth('/api/v1', projectId, fetch, storage)

    const result = await auth.signInWithProvider('oidc', { code: 'oidc_code' })

    expect(result.error).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/auth/oidc/login`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'oidc_code' }),
      })
    )
  })

  it('isolates project sessions by projectId', async () => {
    const fetch = createMockFetch({})
    const storage = createMockStorage()

    await storage.setItem('druvia.project_session:proj_other', JSON.stringify({
      accessToken: 'other-project-token',
      user: { id: 'usr_other' },
    }))

    const auth = new DruviaProjectAuth('/api/v1', projectId, fetch, storage)
    const sessionResult = await auth.getSession()

    expect(sessionResult.data.session).toBeNull()
    expect(storage.getItem).toHaveBeenCalledWith(projectSessionKey)
  })
})
