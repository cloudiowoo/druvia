import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  appleLogin: vi.fn(),
  providerSilentLogin: vi.fn(),
  issueTrustedProjectSession: vi.fn(),
  wechatLogin: vi.fn(),
  wechatSilentLogin: vi.fn(),
  refreshProjectSession: vi.fn(),
  logoutProjectUser: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.service.js', () => ({
  validateTrustedBackendKey: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project-auth/apple-lifecycle.service.js', () => ({
  acknowledgeAppleLifecycleEvent: vi.fn(),
  listPendingAppleLifecycleEvents: vi.fn(),
  processAppleNotification: vi.fn(),
  revokeAppleProjectUser: vi.fn(),
}))

import * as controller from '../../apps/api/src/modules/project-auth/project-auth.controller.js'
import {
  ProjectAuthError,
  appleLogin,
  issueTrustedProjectSession,
  logoutProjectUser,
  providerLogin,
  providerSilentLogin,
  refreshProjectSession,
  wechatLogin,
  wechatSilentLogin,
} from '../../apps/api/src/modules/project-auth/project-auth.service.js'
import { validateTrustedBackendKey } from '../../apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.service.js'
import {
  listPendingAppleLifecycleEvents,
} from '../../apps/api/src/modules/project-auth/apple-lifecycle.service.js'

type ReplyStub = {
  status: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  statusCode?: number
  payload?: unknown
}

function createReply(): ReplyStub {
  const reply: ReplyStub = {
    status: vi.fn(),
    send: vi.fn(),
  }

  reply.status.mockImplementation((code: number) => {
    reply.statusCode = code
    return reply
  })

  reply.send.mockImplementation((payload: unknown) => {
    reply.payload = payload
    return reply
  })

  return reply
}

describe('Project Auth Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows a project-scoped trusted backend to read Apple lifecycle events', async () => {
    vi.mocked(validateTrustedBackendKey).mockResolvedValue({
      valid: true,
      projectId: 'proj_123',
      scopes: ['project_auth_lifecycle:manage'],
      keyPrefix: 'drutb_fixture',
    })
    vi.mocked(listPendingAppleLifecycleEvents).mockResolvedValue({
      items: [{
        id: 7,
        type: 'account-deleted',
        occurredAt: new Date('2026-08-28T00:00:00.000Z'),
        projectUserId: 'project-user-1',
      }],
      nextCursor: null,
    })
    const reply = createReply()

    await controller.listAppleLifecycleEvents({
      params: { projectId: 'proj_123' },
      headers: { 'x-druvia-trusted-backend-key': 'drutb_secret' },
    } as never, reply as never)

    expect(validateTrustedBackendKey).toHaveBeenCalledWith('drutb_secret', {
      requiredScope: 'project_auth_lifecycle:manage',
      requiredProjectId: 'proj_123',
    })
    expect(listPendingAppleLifecycleEvents).toHaveBeenCalledWith('proj_123', {
      limit: 100,
      cursor: undefined,
    })
    expect(reply.payload).toEqual({
      success: true,
      data: { items: expect.any(Array), nextCursor: null },
    })
  })

  it('rejects a trusted backend lifecycle key from another project', async () => {
    vi.mocked(validateTrustedBackendKey).mockResolvedValue({
      valid: false,
      reason: 'project_mismatch',
      projectId: 'proj_other',
      scopes: ['project_auth_lifecycle:manage'],
      keyPrefix: 'drutb_fixture',
    })
    const reply = createReply()

    await controller.listAppleLifecycleEvents({
      params: { projectId: 'proj_123' },
      headers: { 'x-druvia-trusted-backend-key': 'drutb_secret' },
    } as never, reply as never)

    expect(reply.statusCode).toBe(403)
    expect(listPendingAppleLifecycleEvents).not.toHaveBeenCalled()
  })

  it('does not let a Project Session manage Apple lifecycle events', async () => {
    const reply = createReply()

    await controller.listAppleLifecycleEvents({
      params: { projectId: 'proj_123' },
      headers: {},
      user: {
        kind: 'project_user',
        sub: 'project-user-1',
        projectId: 'proj_123',
        authType: 'project_user',
        role: 'authenticated',
        provider: 'apple',
      },
    } as never, reply as never)

    expect(reply.statusCode).toBe(401)
    expect(listPendingAppleLifecycleEvents).not.toHaveBeenCalled()
  })

  it('validates Apple native credential fields before invoking the service', async () => {
    const invalidBodies = [
      {},
      { authorizationCode: 'code', identityToken: 'token', rawNonce: 'short' },
      { authorizationCode: ' '.repeat(2), identityToken: 'token', rawNonce: 'a'.repeat(43) },
      { authorizationCode: 'code', identityToken: 'x'.repeat(16_385), rawNonce: 'a'.repeat(43) },
      { authorizationCode: 'code', identityToken: 'token', rawNonce: `${'a'.repeat(42)}!` },
    ]

    for (const body of invalidBodies) {
      const reply = createReply()
      await controller.appleLogin(
        { params: { projectId: 'proj_123' }, body } as never,
        reply as never,
      )
      expect(reply.statusCode).toBe(400)
    }
    expect(appleLogin).not.toHaveBeenCalled()
  })

  it('sanitizes the optional Apple first-login profile', async () => {
    vi.mocked(appleLogin).mockResolvedValue({
      token: 'access_token',
      refreshToken: 'refresh_token',
      expiresIn: 3600,
      expiresAt: '2026-08-28T08:00:00.000Z',
      user: {
        id: 'project-user',
        email: null,
        username: 'Ada Lovelace',
        avatarUrl: null,
        role: 'authenticated',
      },
    })
    const reply = createReply()

    await controller.appleLogin({
      params: { projectId: 'proj_123' },
      body: {
        authorizationCode: 'authorization-code',
        identityToken: 'identity-token',
        rawNonce: 'a'.repeat(43),
        profile: { givenName: '  Ada\u0000 ', familyName: ' Lovelace  ' },
      },
    } as never, reply as never)

    expect(appleLogin).toHaveBeenCalledWith('proj_123', {
      authorizationCode: 'authorization-code',
      identityToken: 'identity-token',
      rawNonce: 'a'.repeat(43),
      profile: { givenName: 'Ada', familyName: 'Lovelace' },
    })
    expect(reply.payload).toEqual(expect.objectContaining({ success: true }))
  })

  it('rejects Apple silent login as an unsupported provider flow', async () => {
    const reply = createReply()

    await controller.providerSilentLogin({
      params: { projectId: 'proj_123', provider: 'apple' },
      body: { code: 'unused' },
    } as never, reply as never)

    expect(reply.statusCode).toBe(400)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'PROVIDER_FLOW_UNSUPPORTED', message: 'Apple silent login is not supported' },
    })
    expect(providerSilentLogin).not.toHaveBeenCalled()
  })

  it('rejects Apple revoke from a Project Session bound to another project', async () => {
    const reply = createReply()

    await controller.appleRevoke({
      params: { projectId: 'proj_123' },
      user: {
        kind: 'project_user',
        sub: 'user-1',
        projectId: 'proj_other',
        authType: 'project_user',
        role: 'authenticated',
        provider: 'apple',
      },
    } as never, reply as never)

    expect(reply.statusCode).toBe(403)
  })

  it('validates code for wechat login', async () => {
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123' },
      body: {},
    }

    await controller.wechatLogin(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(400)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'code is required' },
    })
    expect(wechatLogin).not.toHaveBeenCalled()
  })

  it('maps ProjectAuthError from silent login to API response', async () => {
    vi.mocked(wechatSilentLogin).mockRejectedValue(
      new ProjectAuthError('USER_NOT_FOUND', 'Project user not found', 404)
    )

    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123' },
      body: { code: 'wx_code' },
    }

    await controller.wechatSilentLogin(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(404)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'USER_NOT_FOUND', message: 'Project user not found' },
    })
  })

  it('maps semantic user creation failures from login to API response', async () => {
    vi.mocked(wechatLogin).mockRejectedValue(
      new ProjectAuthError('USER_CREATE_FAILED', 'Project user creation failed because users.id could not be generated', 500)
    )

    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123' },
      body: { code: 'wx_code', userInfo: {} },
    }

    await controller.wechatLogin(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(500)
    expect(reply.payload).toEqual({
      success: false,
      error: {
        code: 'USER_CREATE_FAILED',
        message: 'Project user creation failed because users.id could not be generated',
      },
    })
  })

  it('forwards generic provider login to the shared service', async () => {
    vi.mocked(providerLogin).mockResolvedValue({
      token: 'access_token',
      refreshToken: 'refresh_token',
      expiresIn: 3600,
      expiresAt: new Date('2026-03-24T01:00:00Z').toISOString(),
      user: {
        id: 'usr_proj_1',
        email: 'user@example.com',
        username: 'OIDC User',
        avatarUrl: null,
        role: 'authenticated',
      },
    })

    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', provider: 'oidc' },
      body: { code: 'oidc_code' },
    }

    await controller.providerLogin(request as never, reply as never)

    expect(providerLogin).toHaveBeenCalledWith('proj_123', 'oidc', {
      code: 'oidc_code',
      userInfo: undefined,
    })
    expect(reply.payload).toEqual({
      success: true,
      data: {
        token: 'access_token',
        refreshToken: 'refresh_token',
        expiresIn: 3600,
        expiresAt: new Date('2026-03-24T01:00:00Z').toISOString(),
        user: {
          id: 'usr_proj_1',
          email: 'user@example.com',
          username: 'OIDC User',
          avatarUrl: null,
          role: 'authenticated',
        },
      },
    })
  })

  it('requires a project user session for logout', async () => {
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123' },
      user: {
        kind: 'platform_user',
        userId: 'usr_admin',
        uid: 1,
      },
    }

    await controller.logout(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Project user authentication required' },
    })
    expect(logoutProjectUser).not.toHaveBeenCalled()
  })

  it('issues trusted sessions only for a valid trusted backend key', async () => {
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
      expiresAt: new Date('2026-03-24T01:00:00Z').toISOString(),
      user: {
        id: 'usr_proj_1',
        email: 'user@example.com',
        username: 'Alice',
        avatarUrl: null,
        role: 'authenticated',
      },
    })

    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123' },
      headers: {
        'x-druvia-trusted-backend-key': 'drutb_secret',
        'user-agent': 'vitest',
      },
      ip: '127.0.0.1',
      body: { userId: 'usr_proj_1' },
      log: { info: vi.fn() },
    }

    await controller.issueTrustedSession(request as never, reply as never)

    expect(validateTrustedBackendKey).toHaveBeenCalledWith('drutb_secret', {
      requiredScope: 'project_session:issue',
      requiredProjectId: 'proj_123',
    })
    expect(issueTrustedProjectSession).toHaveBeenCalledWith('proj_123', 'usr_proj_1')
    expect(reply.payload).toEqual({
      success: true,
      data: {
        token: 'access_token',
        refreshToken: 'refresh_token',
        expiresIn: 3600,
        expiresAt: new Date('2026-03-24T01:00:00Z').toISOString(),
        user: {
          id: 'usr_proj_1',
          email: 'user@example.com',
          username: 'Alice',
          avatarUrl: null,
          role: 'authenticated',
        },
      },
    })
  })

  it('refreshes and logs out with project user context', async () => {
    vi.mocked(refreshProjectSession).mockResolvedValue({
      token: 'access_token',
      refreshToken: 'refresh_token',
      expiresIn: 3600,
      expiresAt: new Date('2026-03-24T01:00:00Z').toISOString(),
      user: {
        id: 'usr_proj_1',
        email: 'user@example.com',
        username: 'Alice',
        avatarUrl: null,
        role: 'authenticated',
      },
    })
    vi.mocked(logoutProjectUser).mockResolvedValue(undefined)

    const refreshReply = createReply()
    await controller.refresh(
      {
        params: { projectId: 'proj_123' },
        body: { refresh_token: 'refresh_token' },
      } as never,
      refreshReply as never
    )

    expect(refreshProjectSession).toHaveBeenCalledWith('proj_123', 'refresh_token')
    expect(refreshReply.payload).toEqual({
      success: true,
      data: {
        token: 'access_token',
        refreshToken: 'refresh_token',
        expiresIn: 3600,
        expiresAt: new Date('2026-03-24T01:00:00Z').toISOString(),
        user: {
          id: 'usr_proj_1',
          email: 'user@example.com',
          username: 'Alice',
          avatarUrl: null,
          role: 'authenticated',
        },
      },
    })

    const logoutReply = createReply()
    await controller.logout(
      {
        params: { projectId: 'proj_123' },
        user: {
          kind: 'project_user',
          sub: 'usr_proj_1',
          projectId: 'proj_123',
          authType: 'project_user',
          role: 'authenticated',
          provider: 'wechat',
        },
      } as never,
      logoutReply as never
    )

    expect(logoutProjectUser).toHaveBeenCalledWith('proj_123', 'usr_proj_1')
    expect(logoutReply.payload).toEqual({
      success: true,
      data: { loggedOut: true },
    })
  })
})
