import { beforeEach, describe, expect, it, vi } from 'vitest'

const { client, query, queryOne, logActivity } = vi.hoisted(() => ({
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  query: vi.fn(),
  queryOne: vi.fn(),
  logActivity: vi.fn(),
}))

vi.mock('../../apps/api/src/db/index.js', () => ({
  query,
  queryOne,
  getClient: vi.fn(async () => client),
}))

vi.mock('../../apps/api/src/modules/activity/activity.service.js', () => ({
  logActivity,
}))

import {
  addProjectMember,
  listProjectMembers,
  removeProjectMember,
  searchProjectMemberCandidates,
} from '../../apps/api/src/modules/project-members/project-members.service.js'

const actor = {
  kind: 'platform_user' as const,
  uid: 1,
  userId: 'usr_owner',
  role: 'admin',
}

describe('project members service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists the implicit workspace owner before explicit members', async () => {
    query.mockResolvedValue([
      {
        user_id: 'usr_owner', email: 'owner@example.com', username: 'owner',
        status: 'active', role: 'owner', is_workspace_owner: true, created_at: null,
      },
      {
        user_id: 'usr_member', email: 'member@example.com', username: null,
        status: 'active', role: 'viewer', is_workspace_owner: false,
        created_at: new Date('2026-09-05T00:00:00.000Z'),
      },
    ])

    const members = await listProjectMembers('proj_1')

    expect(members[0]).toMatchObject({ role: 'owner', isWorkspaceOwner: true })
    expect(members[1]).toMatchObject({ role: 'viewer', isWorkspaceOwner: false })
    expect(members[1]?.createdAt).toBe('2026-09-05T00:00:00.000Z')
    expect(String(query.mock.calls[0]?.[0])).toContain('ORDER BY is_workspace_owner DESC')
  })

  it('searches only active users and excludes owner and existing members', async () => {
    query.mockResolvedValue([{
      user_id: 'usr_candidate', email: 'candidate@example.com', username: 'candidate',
      status: 'active', role: null, is_workspace_owner: false, created_at: null,
    }])

    const candidates = await searchProjectMemberCandidates('proj_1', 'candidate')

    expect(candidates).toHaveLength(1)
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/u\.status = 'active'[\s\S]*pm\.id IS NULL[\s\S]*u\.id <> t\.owner_uid/),
      ['proj_1', '%candidate%'],
    )
  })

  it('rejects candidate searches shorter than two characters', async () => {
    await expect(searchProjectMemberCandidates('proj_1', 'a')).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      statusCode: 400,
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects adding inactive users and rolls back', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ owner_uid: 1, actor_uid: 1, actor_status: 'active', actor_role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ uid: 25, status: 'inactive', is_owner: false }] })
      .mockResolvedValueOnce(undefined)

    await expect(
      addProjectMember(actor, 'proj_1', 'usr_inactive', 'viewer'),
    ).rejects.toMatchObject({ code: 'USER_INACTIVE', statusCode: 409 })
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalled()
  })

  it('maps duplicate memberships to a stable conflict', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ owner_uid: 1, actor_uid: 1, actor_status: 'active', actor_role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{ uid: 25, status: 'active', is_owner: false }] })
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }))
      .mockResolvedValueOnce(undefined)

    await expect(
      addProjectMember(actor, 'proj_1', 'usr_member', 'database_admin'),
    ).rejects.toMatchObject({ code: 'MEMBER_EXISTS', statusCode: 409 })
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
  })

  it('rolls back the membership change when its audit write fails', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ owner_uid: 1, actor_uid: 1, actor_status: 'active', actor_role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{
        uid: 25, user_id: 'usr_member', email: 'member@example.com', username: null,
        status: 'active', is_owner: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ created_at: new Date('2026-09-05T00:00:00Z') }] })
      .mockResolvedValueOnce(undefined)
    logActivity.mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(
      addProjectMember(actor, 'proj_1', 'usr_member', 'viewer', 'req-123'),
    ).rejects.toThrow('audit unavailable')

    expect(logActivity).toHaveBeenCalledWith(
      'usr_owner',
      'project_member.created',
      'project',
      'proj_1',
      expect.objectContaining({ requestId: 'req-123' }),
      client,
    )
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK')
    expect(client.query).not.toHaveBeenCalledWith('COMMIT')
  })

  it('allows an inactive member to be removed', async () => {
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ owner_uid: 1, actor_uid: 1, actor_status: 'active', actor_role: 'admin' }] })
      .mockResolvedValueOnce({ rows: [{
        uid: 25, user_id: 'usr_member', email: 'member@example.com', username: null,
        status: 'inactive', is_owner: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ role: 'viewer' }] })
      .mockResolvedValueOnce(undefined)

    await expect(
      removeProjectMember(actor, 'proj_1', 'usr_member', 'req-remove'),
    ).resolves.toBeUndefined()

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM druvia_project_members'),
      ['proj_1', 25],
    )
    expect(logActivity).toHaveBeenCalledWith(
      'usr_owner',
      'project_member.removed',
      'project',
      'proj_1',
      expect.objectContaining({ targetUserId: 'usr_member', previousRole: 'viewer' }),
      client,
    )
    expect(client.query).toHaveBeenLastCalledWith('COMMIT')
  })
})
