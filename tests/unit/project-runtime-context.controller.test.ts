import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/project/project-runtime-context.service.js', () => ({
  getProjectRuntimeContext: vi.fn(),
  setProjectRuntimeContext: vi.fn(),
  disableProjectRuntimeContext: vi.fn(),
  ProjectRuntimeContextError: class ProjectRuntimeContextError extends Error {
    code = 'PROJECT_RUNTIME_CONTEXT_UNAVAILABLE'
    statusCode = 503
  },
  ProjectRuntimeContextNotFoundError: class ProjectRuntimeContextNotFoundError extends Error {
    code = 'PROJECT_NOT_FOUND'
    statusCode = 404
  },
}))

import * as controller from '../../apps/api/src/modules/project/project-runtime-context.controller.js'
import * as service from '../../apps/api/src/modules/project/project-runtime-context.service.js'

function replyStub() {
  const reply = { status: vi.fn(), send: vi.fn() }
  reply.status.mockReturnValue(reply)
  return reply
}

const owner = {
  kind: 'platform_user' as const,
  uid: 1,
  userId: 'usr_owner',
  role: 'admin',
}

describe('project runtime context controller', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the resolved context without accepting a caller-supplied environment', async () => {
    vi.mocked(service.getProjectRuntimeContext).mockResolvedValue({
      enabled: true,
      serviceEnvironment: 'sandbox',
      revision: 2,
      updatedAt: '2026-09-21T08:00:00.000Z',
    })
    const reply = replyStub()

    await controller.getRuntimeContext({ params: { projectId: 'proj_global' } } as never, reply as never)

    expect(service.getProjectRuntimeContext).toHaveBeenCalledWith('proj_global')
    expect(reply.send).toHaveBeenCalledWith({
      success: true,
      data: {
        enabled: true,
        serviceEnvironment: 'sandbox',
        revision: 2,
        updatedAt: '2026-09-21T08:00:00.000Z',
      },
    })
  })

  it('rejects unknown fields and invalid service environments before configuration writes', async () => {
    const reply = replyStub()

    await controller.setRuntimeContext({
      id: 'req_invalid',
      params: { projectId: 'proj_global' },
      user: owner,
      body: { serviceEnvironment: 'preview', arbitrary: true },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(400)
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'Invalid project runtime context' },
    })
    expect(service.setProjectRuntimeContext).not.toHaveBeenCalled()
  })

  it('writes a validated environment under the authenticated platform actor', async () => {
    vi.mocked(service.setProjectRuntimeContext).mockResolvedValue({
      enabled: true,
      serviceEnvironment: 'sandbox',
      revision: 3,
      updatedAt: '2026-09-21T09:00:00.000Z',
    })
    const reply = replyStub()

    await controller.setRuntimeContext({
      id: 'req_runtime_3',
      params: { projectId: 'proj_global' },
      user: owner,
      body: { serviceEnvironment: 'sandbox' },
    } as never, reply as never)

    expect(service.setProjectRuntimeContext).toHaveBeenCalledWith({
      projectId: 'proj_global',
      serviceEnvironment: 'sandbox',
      actorUserId: 'usr_owner',
      requestId: 'req_runtime_3',
    })
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  })

  it('maps a failed-closed runtime context to a stable response', async () => {
    vi.mocked(service.setProjectRuntimeContext).mockRejectedValue(
      new service.ProjectRuntimeContextError(),
    )
    const reply = replyStub()

    await controller.setRuntimeContext({
      id: 'req_runtime_4',
      params: { projectId: 'proj_global' },
      user: owner,
      body: { serviceEnvironment: 'sandbox' },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(503)
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'PROJECT_RUNTIME_CONTEXT_UNAVAILABLE',
        message: 'Project runtime context is unavailable',
      },
    })
  })

  it('rejects project-session callers even if a route guard is bypassed', async () => {
    const reply = replyStub()

    await controller.setRuntimeContext({
      id: 'req_runtime_5',
      params: { projectId: 'proj_global' },
      user: {
        kind: 'project_user',
        projectId: 'proj_global',
        sub: 'pusr_1',
        authType: 'project_user',
        provider: 'wechat',
        role: 'authenticated',
      },
      body: { serviceEnvironment: 'sandbox' },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(service.setProjectRuntimeContext).not.toHaveBeenCalled()
  })
})
