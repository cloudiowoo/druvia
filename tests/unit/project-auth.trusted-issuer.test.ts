import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/project-auth/project-auth.service.js', () => ({
  ProjectAuthError: class ProjectAuthError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode: number
    ) {
      super(message)
    }
  },
  providerLogin: vi.fn(),
  providerSilentLogin: vi.fn(),
  issueTrustedProjectSession: vi.fn(),
  wechatLogin: vi.fn(),
  wechatSilentLogin: vi.fn(),
  refreshProjectSession: vi.fn(),
  logoutProjectUser: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.service.js', () => ({
  TRUSTED_BACKEND_KEY_SCOPES: ['project_session:issue', 'storage_ticket:issue'],
  createTrustedBackendKey: vi.fn(),
  listTrustedBackendKeys: vi.fn(),
  deleteTrustedBackendKey: vi.fn(),
  validateTrustedBackendKey: vi.fn(),
}))

import { buildApp } from '../../apps/api/src/index.js'
import { signProjectUserToken } from '../../apps/api/src/middleware/auth.js'
import {
  issueTrustedProjectSession,
  logoutProjectUser,
  refreshProjectSession,
} from '../../apps/api/src/modules/project-auth/project-auth.service.js'
import { validateTrustedBackendKey } from '../../apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.service.js'

describe('Project auth trusted issuer routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('requires a trusted backend key and does not accept anonymous apikey fallback', async () => {
    const app = buildApp()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/trusted/issue-session',
        headers: {
          apikey: 'dru_anon_key',
        },
        payload: { userId: 'usr_proj_1' },
      })

      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Trusted backend key required' },
      })
      expect(validateTrustedBackendKey).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('issues a normal project session for an existing user when the trusted key is valid', async () => {
    vi.mocked(validateTrustedBackendKey).mockResolvedValue({
      valid: true,
      projectId: 'proj_123',
      keyPrefix: 'drutb_1234567890',
      scopes: ['project_session:issue'],
    })
    vi.mocked(issueTrustedProjectSession).mockResolvedValue({
      token: 'access_token',
      refreshToken: 'refresh_token',
      expiresIn: 3600,
      expiresAt: '2026-03-28T12:00:00.000Z',
      user: {
        id: 'usr_proj_1',
        email: 'user@example.com',
        username: 'Issuer User',
        avatarUrl: null,
        role: 'authenticated',
      },
    })

    const app = buildApp()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/trusted/issue-session',
        headers: {
          'x-druvia-trusted-backend-key': 'drutb_secret',
          'user-agent': 'vitest',
        },
        payload: { userId: 'usr_proj_1' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        success: true,
        data: {
          token: 'access_token',
          refreshToken: 'refresh_token',
          expiresIn: 3600,
          expiresAt: '2026-03-28T12:00:00.000Z',
          user: {
            id: 'usr_proj_1',
            email: 'user@example.com',
            username: 'Issuer User',
            avatarUrl: null,
            role: 'authenticated',
          },
        },
      })
      expect(validateTrustedBackendKey).toHaveBeenCalledWith('drutb_secret', {
        requiredScope: 'project_session:issue',
        requiredProjectId: 'proj_123',
      })
      expect(issueTrustedProjectSession).toHaveBeenCalledWith('proj_123', 'usr_proj_1')
    } finally {
      await app.close()
    }
  })

  it('rejects trusted backend keys without issuer scope', async () => {
    vi.mocked(validateTrustedBackendKey).mockResolvedValue({
      valid: false,
      reason: 'scope_missing',
      projectId: 'proj_123',
      keyPrefix: 'drutb_1234567890',
      scopes: ['storage_ticket:issue'],
    })

    const app = buildApp()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/trusted/issue-session',
        headers: {
          'x-druvia-trusted-backend-key': 'drutb_secret',
        },
        payload: { userId: 'usr_proj_1' },
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Trusted backend key is missing required scope' },
      })
      expect(issueTrustedProjectSession).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('rejects trusted backend keys bound to another project', async () => {
    vi.mocked(validateTrustedBackendKey).mockResolvedValue({
      valid: false,
      reason: 'project_mismatch',
      projectId: 'proj_other',
      keyPrefix: 'drutb_1234567890',
      scopes: ['project_session:issue'],
    })

    const app = buildApp()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/trusted/issue-session',
        headers: {
          'x-druvia-trusted-backend-key': 'drutb_secret',
        },
        payload: { userId: 'usr_proj_1' },
      })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toEqual({
        success: false,
        error: { code: 'FORBIDDEN', message: 'No access to this project' },
      })
      expect(issueTrustedProjectSession).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('keeps refresh and logout on the normal project session lifecycle', async () => {
    vi.mocked(refreshProjectSession).mockResolvedValue({
      token: 'refreshed_token',
      refreshToken: 'refreshed_refresh_token',
      expiresIn: 3600,
      expiresAt: '2026-03-28T13:00:00.000Z',
      user: {
        id: 'usr_proj_1',
        email: 'user@example.com',
        username: 'Issuer User',
        avatarUrl: null,
        role: 'authenticated',
      },
    })
    vi.mocked(logoutProjectUser).mockResolvedValue(undefined)

    const app = buildApp()
    const accessToken = signProjectUserToken({
      sub: 'usr_proj_1',
      projectId: 'proj_123',
      authType: 'project_user',
      role: 'authenticated',
      provider: 'trusted_backend',
    })

    try {
      const refreshResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/refresh',
        payload: { refresh_token: 'refresh_token_old' },
      })
      const logoutResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/projects/proj_123/auth/logout',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      })

      expect(refreshResponse.statusCode).toBe(200)
      expect(logoutResponse.statusCode).toBe(200)
      expect(refreshProjectSession).toHaveBeenCalledWith('proj_123', 'refresh_token_old')
      expect(logoutProjectUser).toHaveBeenCalledWith('proj_123', 'usr_proj_1')
    } finally {
      await app.close()
    }
  })
})
