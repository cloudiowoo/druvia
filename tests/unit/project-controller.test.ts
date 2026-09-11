import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/project/project.service.js', () => ({
  createProject: vi.fn(),
  getProjectById: vi.fn(),
  deleteProject: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project/db-credentials.service.js', () => ({
  dropProjectDbUser: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/project-authorization.js', () => ({
  AuthorizationError: class AuthorizationError extends Error {
    constructor(public statusCode: number, public code: string, message: string) {
      super(message)
    }
  },
  assertProjectCapability: vi.fn(),
  assertTenantAccess: vi.fn(),
}))

import * as projectController from '../../apps/api/src/modules/project/project.controller.js'
import * as projectService from '../../apps/api/src/modules/project/project.service.js'
import * as dbCredentialsService from '../../apps/api/src/modules/project/db-credentials.service.js'
import { ProjectDeviceWipeError } from '../../apps/api/src/modules/project-auth/project-device-wipe.types.js'
import {
  assertProjectCapability,
  AuthorizationError,
} from '../../apps/api/src/lib/project-authorization.js'
import { DataAccessMutationLockedError } from '../../apps/api/src/modules/data-access/data-access-mutation-lock.js'

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

  it('returns the device wipe lifecycle conflict when database-user deletion is blocked', async () => {
    vi.mocked(dbCredentialsService.dropProjectDbUser).mockRejectedValueOnce(
      new ProjectDeviceWipeError(
        'DEVICE_WIPE_DECOMMISSION_REQUIRED',
        'Project device wipe records must be decommissioned before deleting the database user',
        409,
      ),
    )
    const reply = createReply()

    await projectController.deleteDbUser({
      params: { projectId: 'proj_123' },
    } as never, reply as never)

    expect(reply.statusCode).toBe(409)
    expect(reply.payload).toEqual({
      success: false,
      error: {
        code: 'DEVICE_WIPE_DECOMMISSION_REQUIRED',
        message: 'Project device wipe records must be decommissioned before deleting the database user',
      },
    })
  })

  it('returns conflict when the generated project schema is already in use', async () => {
    vi.mocked(projectService.createProject).mockRejectedValue(
      Object.assign(new Error('schema conflict'), { code: 'PROJECT_SCHEMA_CONFLICT' }),
    )
    const reply = createReply()

    await projectController.createProject({
      params: { tenantId: 'tenant_123' },
      body: { alias: 'appdev', name: 'App Dev' },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(409)
    expect(reply.payload).toEqual({
      success: false,
      error: {
        code: 'PROJECT_SCHEMA_CONFLICT',
        message: 'Project schema name is already in use',
      },
    })
  })

  it('rejects delete requests from non-platform users', async () => {
    vi.mocked(assertProjectCapability).mockRejectedValue(
      new AuthorizationError(401, 'UNAUTHORIZED', 'Platform authentication required'),
    )
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
      error: { code: 'UNAUTHORIZED', message: 'Platform authentication required' },
    })
    expect(projectService.deleteProject).not.toHaveBeenCalled()
    expect(assertProjectCapability).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'project_user' }),
      'proj_123',
      'project:delete',
    )
  })

  it('rejects delete requests when the user has no access to the project', async () => {
    vi.mocked(assertProjectCapability).mockRejectedValue(
      new AuthorizationError(403, 'FORBIDDEN', 'Project capability required'),
    )

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

    expect(assertProjectCapability).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_other' }),
      'proj_123',
      'project:delete',
    )
    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.payload).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Project capability required' },
    })
    expect(projectService.deleteProject).not.toHaveBeenCalled()
  })

  it('allows owners to delete projects they can access', async () => {
    vi.mocked(assertProjectCapability).mockResolvedValue({} as never)

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

    expect(assertProjectCapability).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_owner' }),
      'proj_123',
      'project:delete',
    )
    expect(projectService.deleteProject).toHaveBeenCalledWith('proj_123')
    expect(reply.status).toHaveBeenCalledWith(204)
  })

  it.each([
    new DataAccessMutationLockedError('busy'),
    { code: '55006', constraint: 'druvia_data_access_migrations_inflight_delete_guard' },
  ])('maps migration deletion guards to a stable conflict', async (failure) => {
    vi.mocked(assertProjectCapability).mockResolvedValue({} as never)
    vi.mocked(projectService.deleteProject).mockRejectedValue(failure)
    const reply = createReply()

    await projectController.deleteProject({
      params: { projectId: 'proj_123' },
      user: { kind: 'platform_user', userId: 'usr_owner', uid: 1, role: 'admin' },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(409)
    expect(reply.payload).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'DATA_ACCESS_MIGRATION_IN_PROGRESS' }),
    }))
  })

  it('maps the device wipe decommission guard to a stable conflict', async () => {
    vi.mocked(assertProjectCapability).mockResolvedValue({} as never)
    vi.mocked(projectService.deleteProject).mockRejectedValue(
      new ProjectDeviceWipeError(
        'DEVICE_WIPE_DECOMMISSION_REQUIRED',
        'Project device wipe records must be decommissioned before deleting the project',
        409,
      ),
    )
    const reply = createReply()

    await projectController.deleteProject({
      params: { projectId: 'proj_123' },
      user: { kind: 'platform_user', userId: 'usr_owner', uid: 1, role: 'admin' },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(409)
    expect(reply.payload).toEqual({
      success: false,
      error: {
        code: 'DEVICE_WIPE_DECOMMISSION_REQUIRED',
        message: 'Project device wipe records must be decommissioned before deleting the project',
      },
    })
  })

  it('rethrows unrelated project deletion failures', async () => {
    vi.mocked(assertProjectCapability).mockResolvedValue({} as never)
    const failure = new Error('storage unavailable')
    vi.mocked(projectService.deleteProject).mockRejectedValue(failure)

    await expect(projectController.deleteProject({
      params: { projectId: 'proj_123' },
      user: { kind: 'platform_user', userId: 'usr_owner', uid: 1, role: 'admin' },
    } as never, createReply() as never)).rejects.toBe(failure)
  })
})
