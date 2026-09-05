import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/functions/functions.service.js', () => ({
  FunctionActorScopeError: class FunctionActorScopeError extends Error {},
  FunctionDisabledError: class FunctionDisabledError extends Error {},
  FunctionInvokeForbiddenError: class FunctionInvokeForbiddenError extends Error {},
  FunctionNotFoundError: class FunctionNotFoundError extends Error {},
  getFunction: vi.fn(),
  invokeFunction: vi.fn(),
  listFunctions: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/project-authorization.js', () => ({
  assertProjectCapability: vi.fn(),
}))

import * as functionsController from '../../apps/api/src/modules/functions/functions.controller.js'
import * as functionsService from '../../apps/api/src/modules/functions/functions.service.js'
import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import { assertProjectCapability } from '../../apps/api/src/lib/project-authorization.js'

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

const successfulResult = {
  success: true,
  data: { ok: true },
  duration: 12,
  executionId: 'exec_123',
}

describe('Functions Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(projectService.getProjectById).mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_proj_123',
    } as Awaited<ReturnType<typeof projectService.getProjectById>>)
    vi.mocked(functionsService.invokeFunction).mockResolvedValue(successfulResult)
  })

  it('passes a canonical same-project API key actor to the service', async () => {
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', name: 'wx-login-register' },
      body: { payload: { code: 'wx_code' } },
      user: {
        kind: 'apikey' as const,
        projectId: 'proj_123',
        role: 'anon' as const,
        apiKeyId: 17,
        apiKeyPrefix: 'drv_test',
      },
    }

    await functionsController.invokeFunction(request as never, reply as never)

    expect(functionsService.getFunction).not.toHaveBeenCalled()
    expect(functionsService.invokeFunction).toHaveBeenCalledWith(
      'proj_123',
      'wx-login-register',
      { code: 'wx_code' },
      {
        version: 1,
        actorType: 'apikey',
        source: 'project_api_key',
        projectId: 'proj_123',
        subject: 'apikey:17',
        role: 'anon',
        apiKeyId: 17,
        apiKeyPrefix: 'drv_test',
      }
    )
    expect(reply.send).toHaveBeenCalledWith({ success: true, data: successfulResult })
  })

  it('passes a canonical same-project Project User actor to the service', async () => {
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', name: 'upload-avatar' },
      body: { payload: { fileName: 'avatar.png' } },
      user: {
        kind: 'project_user' as const,
        sub: 'usr_proj_123',
        projectId: 'proj_123',
        authType: 'project_user' as const,
        role: 'authenticated' as const,
        provider: 'trusted_backend',
      },
    }

    await functionsController.invokeFunction(request as never, reply as never)

    expect(functionsService.invokeFunction).toHaveBeenCalledWith(
      'proj_123',
      'upload-avatar',
      { fileName: 'avatar.png' },
      {
        version: 1,
        actorType: 'project_user',
        source: 'project_session',
        projectId: 'proj_123',
        subject: 'project_user:usr_proj_123',
        role: 'authenticated',
        projectUserId: 'usr_proj_123',
        provider: 'trusted_backend',
      }
    )
    expect(assertProjectCapability).not.toHaveBeenCalled()
    expect(functionsService.getFunction).not.toHaveBeenCalled()
  })

  it('passes an explicitly authorized Platform User actor to the service', async () => {
    vi.mocked(assertProjectCapability).mockResolvedValue({
      projectId: 'proj_123',
      role: 'project_admin',
      capabilities: ['functions:manage'],
      isWorkspaceOwner: false,
      isSuperAdmin: false,
    })
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', name: 'upload-avatar' },
      body: {},
      user: {
        kind: 'platform_user' as const,
        userId: 'user_123',
        uid: 42,
        tenantId: 'tenant_123',
        role: 'user',
      },
    }

    await functionsController.invokeFunction(request as never, reply as never)

    expect(assertProjectCapability).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_123' }),
      'proj_123',
      'functions:manage',
    )
    expect(functionsService.invokeFunction).toHaveBeenCalledWith(
      'proj_123',
      'upload-avatar',
      undefined,
      {
        version: 1,
        actorType: 'platform_user',
        source: 'platform_session',
        projectId: 'proj_123',
        subject: 'platform_user:user_123',
        role: 'user',
        platformUserId: 'user_123',
        platformUid: 42,
        tenantId: 'tenant_123',
      }
    )
  })

  it('maps service-level API key mode rejection to a sanitized 403', async () => {
    vi.mocked(functionsService.invokeFunction).mockRejectedValue(
      new functionsService.FunctionInvokeForbiddenError()
    )
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', name: 'upload-avatar' },
      body: { payload: { fileName: 'avatar.png' } },
      user: {
        kind: 'apikey' as const,
        projectId: 'proj_123',
        role: 'anon' as const,
        apiKeyId: 17,
        apiKeyPrefix: 'drv_test',
      },
    }

    await functionsController.invokeFunction(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Function requires an authenticated user' },
    })
  })

  it('maps a missing function from the service to a sanitized 404', async () => {
    vi.mocked(functionsService.invokeFunction).mockRejectedValue(
      new functionsService.FunctionNotFoundError()
    )
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', name: 'missing' },
      body: {},
      user: {
        kind: 'apikey' as const,
        projectId: 'proj_123',
        role: 'anon' as const,
        apiKeyId: 17,
        apiKeyPrefix: 'drv_test',
      },
    }

    await functionsController.invokeFunction(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(404)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Function not found' },
    })
  })

  it('rejects invoke requests from a different project before service execution', async () => {
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', name: 'wx-login-register' },
      body: { payload: { code: 'wx_code' } },
      user: {
        kind: 'apikey' as const,
        projectId: 'proj_other',
        role: 'anon' as const,
        apiKeyId: 17,
        apiKeyPrefix: 'drv_test',
      },
    }

    await functionsController.invokeFunction(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    })
    expect(functionsService.invokeFunction).not.toHaveBeenCalled()
  })

  it('keeps function management routes unavailable to API key users', async () => {
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123' },
      user: {
        kind: 'apikey' as const,
        projectId: 'proj_123',
        role: 'anon' as const,
        apiKeyId: 17,
        apiKeyPrefix: 'drv_test',
      },
    }

    await functionsController.listFunctions(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    })
    expect(functionsService.listFunctions).not.toHaveBeenCalled()
    expect(assertProjectCapability).not.toHaveBeenCalled()
  })
})
