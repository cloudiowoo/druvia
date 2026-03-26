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
  providerSilentLogin: vi.fn(),
  wechatLogin: vi.fn(),
  wechatSilentLogin: vi.fn(),
  refreshProjectSession: vi.fn(),
  logoutProjectUser: vi.fn(),
}))

import * as controller from '../../apps/api/src/modules/project-auth/project-auth.controller.js'
import {
  ProjectAuthError,
  logoutProjectUser,
  providerLogin,
  providerSilentLogin,
  refreshProjectSession,
  wechatLogin,
  wechatSilentLogin,
} from '../../apps/api/src/modules/project-auth/project-auth.service.js'

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
