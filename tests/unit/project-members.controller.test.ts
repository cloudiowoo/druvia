import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/lib/project-authorization.js', () => ({
  assertProjectCapability: vi.fn(),
  resolveProjectAccess: vi.fn(),
}))

vi.mock('../../apps/api/src/modules/project-members/project-members.service.js', () => ({
  listProjectMembers: vi.fn(),
  searchProjectMemberCandidates: vi.fn(),
  addProjectMember: vi.fn(),
  updateProjectMemberRole: vi.fn(),
  removeProjectMember: vi.fn(),
  isProjectMemberRole: vi.fn((value: string) => ['project_admin', 'database_admin', 'viewer'].includes(value)),
}))

import * as authorization from '../../apps/api/src/lib/project-authorization.js'
import * as controller from '../../apps/api/src/modules/project-members/project-members.controller.js'
import * as service from '../../apps/api/src/modules/project-members/project-members.service.js'

function replyStub() {
  const reply = { status: vi.fn(), send: vi.fn() }
  reply.status.mockReturnValue(reply)
  reply.send.mockReturnValue(reply)
  return reply
}

const owner = {
  kind: 'platform_user' as const,
  uid: 1,
  userId: 'usr_owner',
  role: 'admin',
}

describe('project members controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authorization.assertProjectCapability).mockResolvedValue({
      projectId: 'proj_1', role: 'owner', capabilities: ['members:read', 'members:manage'],
      isWorkspaceOwner: true, isSuperAdmin: false,
    })
  })

  it('returns computed access for an authorized platform user', async () => {
    vi.mocked(authorization.resolveProjectAccess).mockResolvedValue({
      projectId: 'proj_1', role: 'viewer', capabilities: ['project:read'],
      isWorkspaceOwner: false, isSuperAdmin: false,
    })
    const reply = replyStub()

    await controller.getProjectAccess({ params: { projectId: 'proj_1' }, user: owner } as never, reply as never)

    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ role: 'viewer' }),
    }))
  })

  it('requires members:manage before adding a member', async () => {
    vi.mocked(service.addProjectMember).mockResolvedValue({ userId: 'usr_member' } as never)
    const reply = replyStub()

    await controller.createProjectMember({
      id: 'req-123',
      params: { projectId: 'proj_1' },
      body: { userId: 'usr_member', role: 'viewer' },
      user: owner,
    } as never, reply as never)

    expect(authorization.assertProjectCapability).toHaveBeenCalledWith(owner, 'proj_1', 'members:manage')
    expect(service.addProjectMember).toHaveBeenCalledWith(
      owner, 'proj_1', 'usr_member', 'viewer', 'req-123',
    )
    expect(reply.status).toHaveBeenCalledWith(201)
  })

  it('rejects non-platform identities through the authorization boundary', async () => {
    vi.mocked(authorization.assertProjectCapability).mockRejectedValue(Object.assign(
      new Error('Platform authentication required'),
      { statusCode: 401, code: 'UNAUTHORIZED' },
    ))
    const reply = replyStub()

    await controller.listProjectMembers({
      params: { projectId: 'proj_1' },
      user: { kind: 'apikey', projectId: 'proj_1', role: 'anon', apiKeyId: 1, apiKeyPrefix: 'x' },
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(service.listProjectMembers).not.toHaveBeenCalled()
  })

  it('rejects unknown member roles before calling the service', async () => {
    const reply = replyStub()

    await controller.createProjectMember({
      params: { projectId: 'proj_1' },
      body: { userId: 'usr_member', role: 'custom' },
      user: owner,
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(400)
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INVALID_ROLE', message: 'Invalid project member role' },
    })
    expect(service.addProjectMember).not.toHaveBeenCalled()
  })
})
