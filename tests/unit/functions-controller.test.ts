import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/functions/functions.service.js', () => ({
  getFunction: vi.fn(),
  invokeFunction: vi.fn(),
  listFunctions: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/access.js', () => ({
  checkProjectAccess: vi.fn(),
}))

import * as functionsController from '../../apps/api/src/modules/functions/functions.controller.js'
import * as functionsService from '../../apps/api/src/modules/functions/functions.service.js'
import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import * as access from '../../apps/api/src/lib/access.js'

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

describe('Functions Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(projectService.getProjectById).mockResolvedValue({
      projectId: 'proj_123',
      schemaName: 'dru_proj_123',
    } as Awaited<ReturnType<typeof projectService.getProjectById>>)
    vi.mocked(functionsService.getFunction).mockResolvedValue({
      id: 'fn_123',
      projectId: 'proj_123',
      name: 'wx-login-register',
      code: 'return {}',
      runtime: 'deno',
      status: 'active',
      invokeAuthMode: 'anon_allowed',
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  })

  it('allows same-project apikey users to invoke anon-allowed functions', async () => {
    vi.mocked(functionsService.invokeFunction).mockResolvedValue({
      success: true,
      data: { ok: true },
      duration: 12,
      executionId: 'exec_123',
    })

    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', name: 'wx-login-register' },
      body: { payload: { code: 'wx_code' } },
      user: { projectId: 'proj_123', role: 'anon' as const },
    }

    await functionsController.invokeFunction(request as never, reply as never)

    expect(functionsService.invokeFunction).toHaveBeenCalledWith(
      'proj_123',
      'wx-login-register',
      { code: 'wx_code' },
      {
        authType: 'apikey',
        projectId: 'proj_123',
        role: 'anon',
      }
    )
    expect(reply.send).toHaveBeenCalledWith({
      success: true,
      data: {
        success: true,
        data: { ok: true },
        duration: 12,
        executionId: 'exec_123',
      },
    })
  })

  it('rejects apikey invoke requests for jwt-required functions', async () => {
    vi.mocked(functionsService.getFunction).mockResolvedValue({
      id: 'fn_456',
      projectId: 'proj_123',
      name: 'upload-avatar',
      code: 'return {}',
      runtime: 'deno',
      status: 'active',
      invokeAuthMode: 'jwt_required',
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', name: 'upload-avatar' },
      body: { payload: { fileName: 'avatar.png' } },
      user: { projectId: 'proj_123', role: 'anon' as const },
    }

    await functionsController.invokeFunction(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Function requires an authenticated user' },
    })
    expect(functionsService.invokeFunction).not.toHaveBeenCalled()
  })

  it('rejects apikey invoke requests for a different project', async () => {
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123', name: 'wx-login-register' },
      body: { payload: { code: 'wx_code' } },
      user: { projectId: 'proj_other', role: 'anon' as const },
    }

    await functionsController.invokeFunction(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    })
    expect(functionsService.invokeFunction).not.toHaveBeenCalled()
  })

  it('keeps function management routes unavailable to apikey users', async () => {
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123' },
      user: { projectId: 'proj_123', role: 'anon' as const },
    }

    await functionsController.listFunctions(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    })
    expect(functionsService.listFunctions).not.toHaveBeenCalled()
    expect(access.checkProjectAccess).not.toHaveBeenCalled()
  })
})
