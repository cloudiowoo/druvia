import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { rateLimitMock, tokenIssuerMock, publicUrlMock, projectServiceMock, loggerMock } = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
  tokenIssuerMock: vi.fn(),
  publicUrlMock: vi.fn(),
  projectServiceMock: {
    getProjectById: vi.fn(),
  },
  loggerMock: {
    info: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/access.js', () => ({
  checkProjectAccess: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/project-authorization.js', () => {
  class AuthorizationError extends Error {}
  return {
    AuthorizationError,
    assertProjectCapability: vi.fn(),
  }
})

vi.mock('../../apps/api/src/middleware/ratelimit.js', () => ({
  checkRealtimeTokenRateLimit: rateLimitMock,
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => projectServiceMock)

vi.mock('../../apps/api/src/modules/realtime/realtime-token.service.js', () => {
  class RealtimeTokenUnavailableError extends Error {
    readonly code = 'REALTIME_TOKEN_UNAVAILABLE'
  }
  return {
    RealtimeTokenUnavailableError,
    derivePublicRealtimeUrl: publicUrlMock,
    issueRealtimeAccessToken: tokenIssuerMock,
  }
})

vi.mock('../../apps/api/src/lib/logger.js', () => ({
  createApiLogger: vi.fn(() => loggerMock),
}))

import { query, queryOne } from '../../apps/api/src/db/index.js'
import { checkProjectAccess } from '../../apps/api/src/lib/access.js'
import { assertProjectCapability } from '../../apps/api/src/lib/project-authorization.js'
import * as realtimeController from '../../apps/api/src/modules/realtime/realtime.controller.js'

function createReply() {
  const reply = {
    sent: false,
    status: vi.fn(),
    send: vi.fn(),
  }
  reply.status.mockReturnValue(reply)
  reply.send.mockImplementation(() => {
    reply.sent = true
    return reply
  })
  return reply
}

describe('Realtime Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(checkProjectAccess).mockResolvedValue(true)
    vi.mocked(assertProjectCapability).mockResolvedValue({
      projectId: 'proj_123',
      role: 'owner',
      capabilities: ['realtime:manage'],
      isWorkspaceOwner: true,
      isSuperAdmin: false,
    })
    vi.mocked(queryOne).mockResolvedValue({
      schema_name: 'dru_test',
      data_access_mode: 'compatibility',
    } as never)
    projectServiceMock.getProjectById.mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_test',
      dataAccessMode: 'compatibility',
    })
    rateLimitMock.mockResolvedValue(undefined)
    tokenIssuerMock.mockReturnValue({
      token: 'signed-realtime-token',
      operationId: 'op_realtime_123',
      expiresIn: 300,
      expiresAt: '2026-08-17T12:00:00.000Z',
      websocketUrl: 'wss://druvia.example.com/v1/graphql',
    })
    publicUrlMock.mockReturnValue('wss://druvia.example.com/v1/graphql')
    vi.mocked(query).mockImplementation(async (sql) => {
      if (String(sql).includes('FROM information_schema.tables')) {
        return [{ table_name: 'events', realtime_enabled: true }] as never
      }
      return [] as never
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ sources: [] }),
      text: vi.fn().mockResolvedValue(''),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads subscriptions once and derives stats from the same snapshot', async () => {
    const request = {
      params: { projectId: 'proj_123' },
      query: {},
      user: { userId: 'usr_123' },
    }
    const reply = createReply()

    await realtimeController.listSubscriptions(request as never, reply as never)

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(reply.send).toHaveBeenCalledWith({
      success: true,
      data: {
        subscriptions: [expect.objectContaining({ tableName: 'events', enabled: true })],
        stats: { totalTables: 1, enabledTables: 1, disabledTables: 0 },
      },
    })
  })

  describe('issueToken', () => {
    const projectUser = {
      kind: 'project_user' as const,
      sub: 'usr_project_1',
      projectId: 'proj_123',
      authType: 'project_user' as const,
      role: 'authenticated' as const,
      provider: 'wechat',
    }

    it('rejects platform actors before loading the project', async () => {
      const reply = createReply()

      await realtimeController.issueToken({
        id: 'req_platform',
        params: { projectId: 'proj_123' },
        user: { kind: 'platform_user', userId: 'usr_admin', uid: 1 },
      } as never, reply as never)

      expect(reply.status).toHaveBeenCalledWith(403)
      expect(reply.send).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'PROJECT_ACTOR_REQUIRED',
          message: 'Project actor credential required',
        },
      })
      expect(projectServiceMock.getProjectById).not.toHaveBeenCalled()
    })

    it('rejects cross-project actors before loading the project', async () => {
      const reply = createReply()

      await realtimeController.issueToken({
        id: 'req_scope',
        params: { projectId: 'proj_other' },
        user: projectUser,
      } as never, reply as never)

      expect(reply.status).toHaveBeenCalledWith(403)
      expect(reply.send).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'PROJECT_SCOPE_MISMATCH',
          message: 'Project actor does not match the requested project',
        },
      })
      expect(projectServiceMock.getProjectById).not.toHaveBeenCalled()
    })

    it('returns not found for a missing project or schema', async () => {
      projectServiceMock.getProjectById.mockResolvedValueOnce(null)
      const reply = createReply()

      await realtimeController.issueToken({
        id: 'req_missing',
        params: { projectId: 'proj_123' },
        user: projectUser,
      } as never, reply as never)

      expect(reply.status).toHaveBeenCalledWith(404)
      expect(reply.send).toHaveBeenCalledWith({
        success: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
      })
      expect(rateLimitMock).not.toHaveBeenCalled()
    })

    it('stops before signing when the limiter sends a rejection', async () => {
      rateLimitMock.mockImplementationOnce(async (_request, reply) => {
        reply.sent = true
      })
      const reply = createReply()

      await realtimeController.issueToken({
        id: 'req_limited',
        params: { projectId: 'proj_123' },
        user: projectUser,
      } as never, reply as never)

      expect(tokenIssuerMock).not.toHaveBeenCalled()
    })

    it('maps an unavailable signer to a stable 503 error', async () => {
      const { RealtimeTokenUnavailableError } = await import(
        '../../apps/api/src/modules/realtime/realtime-token.service.js'
      )
      tokenIssuerMock.mockImplementationOnce(() => {
        throw new RealtimeTokenUnavailableError('configuration details')
      })
      const reply = createReply()

      await realtimeController.issueToken({
        id: 'req_unavailable',
        params: { projectId: 'proj_123' },
        user: projectUser,
      } as never, reply as never)

      expect(reply.status).toHaveBeenCalledWith(503)
      expect(reply.send).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'REALTIME_TOKEN_UNAVAILABLE',
          message: 'Realtime token service is unavailable',
        },
      })
    })

    it('loads one project, signs its actor context and returns only public fields', async () => {
      const reply = createReply()

      await realtimeController.issueToken({
        id: 'req_success',
        params: { projectId: 'proj_123' },
        headers: {
          authorization: 'Bearer must-not-be-logged',
          apikey: 'must-not-be-logged',
        },
        user: projectUser,
      } as never, reply as never)

      expect(projectServiceMock.getProjectById).toHaveBeenCalledTimes(1)
      expect(rateLimitMock).toHaveBeenCalledWith(expect.anything(), reply, 'proj_123')
      expect(tokenIssuerMock).toHaveBeenCalledWith({
        projectId: 'proj_123',
        context: {
          role: 'user',
          actorType: 'project_user',
          subject: 'usr_project_1',
          sessionVariables: {
            'x-hasura-user-id': 'usr_project_1',
            'x-hasura-project-id': 'proj_123',
            'x-hasura-actor-type': 'project_user',
          },
        },
      })
      expect(reply.send).toHaveBeenCalledWith({
        success: true,
        data: {
          token: 'signed-realtime-token',
          expiresIn: 300,
          expiresAt: '2026-08-17T12:00:00.000Z',
          websocketUrl: 'wss://druvia.example.com/v1/graphql',
        },
      })
      expect(loggerMock.info).toHaveBeenCalledWith(
        'Realtime access token issued',
        {
          requestId: 'req_success',
          operationId: 'op_realtime_123',
          projectId: 'proj_123',
          actorType: 'project_user',
          projectUserId: 'usr_project_1',
          runtimeMode: 'compatibility',
          expiresAt: '2026-08-17T12:00:00.000Z',
        }
      )
      expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain('must-not-be-logged')
      expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain('signed-realtime-token')
    })
  })

  describe('management runtime target', () => {
    it('returns production runtime availability with public endpoints', async () => {
      const reply = createReply()

      await realtimeController.getConfig({
        params: { projectId: 'proj_123' },
        query: {},
        user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      } as never, reply as never)

      expect(publicUrlMock).toHaveBeenCalled()
      expect(reply.send).toHaveBeenCalledWith({
        success: true,
        data: {
          schemaName: 'dru_test',
          websocketEndpoint: 'wss://druvia.example.com/v1/graphql',
          graphqlEndpoint: 'https://druvia.example.com/v1/graphql',
          runtimeAvailability: 'available',
          hasuraConnected: true,
        },
      })
    })

    it('uses an immutable environment ID and reports token identity limitations', async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({
        id: 42,
        schema_name: 'dru_test_dev',
        data_access_mode: 'explicit',
      } as never)
      const reply = createReply()

      await realtimeController.getConfig({
        params: { projectId: 'proj_123' },
        query: { env: 'dev' },
        user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      } as never, reply as never)

      expect(String(vi.mocked(queryOne).mock.calls[0][0])).toContain('e.id')
      expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          schemaName: 'dru_test_dev',
          runtimeAvailability: 'environment_identity_required',
        }),
      }))
    })

    it('maps public-origin configuration failures to the stable 503 envelope', async () => {
      const { RealtimeTokenUnavailableError } = await import(
        '../../apps/api/src/modules/realtime/realtime-token.service.js'
      )
      publicUrlMock.mockImplementationOnce(() => {
        throw new RealtimeTokenUnavailableError('private configuration detail')
      })
      const reply = createReply()

      await realtimeController.getConfig({
        params: { projectId: 'proj_123' },
        query: {},
        user: { kind: 'platform_user', userId: 'usr_123', uid: 1 },
      } as never, reply as never)

      expect(reply.status).toHaveBeenCalledWith(503)
      expect(reply.send).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'REALTIME_TOKEN_UNAVAILABLE',
          message: 'Realtime token service is unavailable',
        },
      })
      expect(JSON.stringify(reply.send.mock.calls)).not.toContain('private configuration detail')
    })
  })
})
