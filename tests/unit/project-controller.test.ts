import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  getProjectById: vi.fn(),
  deleteProject: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/access.js', () => ({
  checkProjectAccess: vi.fn(),
}))

import * as projectController from '../../apps/api/src/modules/project/project.controller.js'
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

describe('Project Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(projectService.getProjectById).mockResolvedValue({
      projectId: 'proj_123',
      tenantId: 'tenant_123',
      schemaName: 'dru_test',
    } as Awaited<ReturnType<typeof projectService.getProjectById>>)
    vi.mocked(projectService.deleteProject).mockResolvedValue(true)
  })

  it('rejects delete requests from non-platform users', async () => {
    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123' },
      user: {
        kind: 'project_user' as const,
        sub: 'usr_proj_123',
        projectId: 'proj_123',
        authType: 'project_user' as const,
        role: 'authenticated' as const,
        provider: 'wechat',
      },
    }

    await projectController.deleteProject(request as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    })
    expect(projectService.deleteProject).not.toHaveBeenCalled()
    expect(access.checkProjectAccess).not.toHaveBeenCalled()
  })

  it('rejects delete requests when the user has no access to the project', async () => {
    vi.mocked(access.checkProjectAccess).mockResolvedValue(false)

    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123' },
      user: {
        kind: 'platform_user' as const,
        userId: 'usr_other',
        uid: 2,
        role: 'admin',
      },
    }

    await projectController.deleteProject(request as never, reply as never)

    expect(access.checkProjectAccess).toHaveBeenCalledWith('usr_other', 'proj_123')
    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'No access to this project' },
    })
    expect(projectService.deleteProject).not.toHaveBeenCalled()
  })

  it('allows owners to delete projects they can access', async () => {
    vi.mocked(access.checkProjectAccess).mockResolvedValue(true)

    const reply = createReply()
    const request = {
      params: { projectId: 'proj_123' },
      user: {
        kind: 'platform_user' as const,
        userId: 'usr_owner',
        uid: 1,
        role: 'admin',
      },
    }

    await projectController.deleteProject(request as never, reply as never)

    expect(access.checkProjectAccess).toHaveBeenCalledWith('usr_owner', 'proj_123')
    expect(projectService.deleteProject).toHaveBeenCalledWith('proj_123')
    expect(reply.status).toHaveBeenCalledWith(204)
  })
})
