import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

import { query, queryOne } from '../../apps/api/src/db/index.js'
import {
  ROLE_CAPABILITIES,
  assertProjectCapability,
  assertTenantAccess,
  listAccessibleProjectIds,
  requireCurrentSuperAdmin,
  requireSchemaCapability,
  resolveProjectAccess,
  resolveSchemaProject,
} from '../../apps/api/src/lib/project-authorization.js'
import type { PlatformJwtUser, RequestUser } from '../../apps/api/src/middleware/auth.js'

const platformUser = (overrides: Partial<PlatformJwtUser> = {}): PlatformJwtUser => ({
  kind: 'platform_user',
  uid: 25,
  userId: 'user_pitchetch',
  role: 'admin',
  ...overrides,
})

const projectRow = (overrides: Record<string, unknown> = {}) => ({
  project_id: 'proj_pitch',
  user_uid: 25,
  user_id: 'user_pitchetch',
  user_status: 'active',
  platform_role: 'admin',
  owner_uid: 1,
  member_role: 'database_admin',
  ...overrides,
})

describe('project authorization', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset()
    vi.mocked(queryOne).mockReset()
  })

  it('uses the fixed capability matrix for each effective role', () => {
    expect(ROLE_CAPABILITIES.owner).toContain('members:manage')
    expect(ROLE_CAPABILITIES.project_admin).toContain('auth:manage')
    expect(ROLE_CAPABILITIES.project_admin).not.toContain('trusted_keys:manage')
    expect(ROLE_CAPABILITIES.database_admin).toContain('database:write')
    expect(ROLE_CAPABILITIES.database_admin).not.toContain('auth:manage')
    expect(ROLE_CAPABILITIES.viewer).toEqual([
      'project:read',
      'members:read',
      'database:read',
    ])
  })

  it('resolves an active project member from the current database relationship', async () => {
    vi.mocked(queryOne).mockResolvedValue(projectRow() as never)

    const access = await resolveProjectAccess(platformUser(), 'proj_pitch')

    expect(access).toMatchObject({
      projectId: 'proj_pitch',
      role: 'database_admin',
      isWorkspaceOwner: false,
      isSuperAdmin: false,
    })
    expect(access?.capabilities).toContain('database:write')
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('u.id = $2'), [
      'proj_pitch',
      25,
      'user_pitchetch',
    ])
  })

  it('uses the current database role and ignores a stale super_admin JWT claim', async () => {
    vi.mocked(queryOne).mockResolvedValue(projectRow({ member_role: null }) as never)

    const access = await resolveProjectAccess(
      platformUser({ role: 'super_admin' }),
      'proj_pitch',
    )

    expect(access).toBeNull()
  })

  it('grants owner capabilities when the current database role is super_admin', async () => {
    vi.mocked(queryOne).mockResolvedValue(projectRow({
      platform_role: 'super_admin',
      member_role: null,
    }) as never)

    const access = await resolveProjectAccess(platformUser(), 'proj_pitch')

    expect(access?.role).toBe('owner')
    expect(access?.isSuperAdmin).toBe(true)
    expect(access?.capabilities).toEqual(ROLE_CAPABILITIES.owner)
  })

  it('rejects inactive, mismatched and non-platform identities', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(projectRow({ user_status: 'inactive' }) as never)
    expect(await resolveProjectAccess(platformUser(), 'proj_pitch')).toBeNull()

    vi.mocked(queryOne).mockResolvedValueOnce(projectRow({ user_uid: null, user_id: null }) as never)
    expect(await resolveProjectAccess(platformUser(), 'proj_pitch')).toBeNull()

    const projectUser: RequestUser = {
      kind: 'project_user',
      sub: 'project-user-1',
      projectId: 'proj_pitch',
      authType: 'project_user',
      role: 'authenticated',
      provider: 'wechat',
    }
    expect(await resolveProjectAccess(projectUser, 'proj_pitch')).toBeNull()
    expect(queryOne).toHaveBeenCalledTimes(2)
  })

  it('distinguishes missing projects from forbidden capabilities', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null)
    await expect(
      assertProjectCapability(platformUser(), 'proj_missing', 'project:read'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_NOT_FOUND' })

    vi.mocked(queryOne).mockResolvedValueOnce(projectRow({ member_role: 'viewer' }) as never)
    await expect(
      assertProjectCapability(platformUser(), 'proj_pitch', 'database:write'),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' })
  })

  it('requires the current database role for super_admin operations', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      user_id: 'user_pitchetch',
      status: 'active',
      role: 'admin',
    } as never)
    await expect(
      requireCurrentSuperAdmin(platformUser({ role: 'super_admin' })),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' })

    vi.mocked(queryOne).mockResolvedValueOnce({
      user_id: 'user_pitchetch',
      status: 'active',
      role: 'super_admin',
    } as never)
    await expect(requireCurrentSuperAdmin(platformUser())).resolves.toBeUndefined()
  })

  it('resolves base and environment schemas to their owning project', async () => {
    vi.mocked(query).mockResolvedValue([{ project_id: 'proj_pitch' }] as never)

    await expect(resolveSchemaProject('dru_default_pitchetch')).resolves.toBe('proj_pitch')
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('druvia_project_environments'),
      ['dru_default_pitchetch'],
    )
  })

  it('fails closed when a schema maps to more than one project', async () => {
    vi.mocked(query).mockResolvedValue([
      { project_id: 'proj_a' },
      { project_id: 'proj_b' },
    ] as never)

    await expect(resolveSchemaProject('dru_default_shared')).resolves.toBeNull()
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT DISTINCT[\s\S]*LIMIT 2/),
      ['dru_default_shared'],
    )
  })

  it('rejects schema capability checks for ambiguous schema ownership', async () => {
    vi.mocked(query).mockResolvedValue([
      { project_id: 'proj_a' },
      { project_id: 'proj_b' },
    ] as never)
    const reply = { status: vi.fn(), send: vi.fn() }
    reply.status.mockReturnValue(reply)
    reply.send.mockReturnValue(reply)

    await requireSchemaCapability('database:read')({
      params: { schema: 'dru_default_shared' },
      user: platformUser(),
    } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(404)
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
    }))
    expect(queryOne).not.toHaveBeenCalled()
  })

  it('allows tenant navigation for a project member but keeps owner writes restricted', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      tenant_id: 'default', user_uid: 25, user_status: 'active', platform_role: 'admin',
      owner_uid: 1, has_project_membership: true,
    } as never)
    await expect(assertTenantAccess(platformUser(), 'default')).resolves.toMatchObject({
      tenantId: 'default', isWorkspaceOwner: false, isSuperAdmin: false,
    })

    vi.mocked(queryOne).mockResolvedValueOnce({
      tenant_id: 'default', user_uid: 25, user_status: 'active', platform_role: 'admin',
      owner_uid: 1, has_project_membership: true,
    } as never)
    await expect(assertTenantAccess(platformUser(), 'default', { ownerOnly: true }))
      .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' })
  })

  it('filters accessible project IDs by the requested capability', async () => {
    vi.mocked(query).mockResolvedValue([{ project_id: 'proj_pitch' }] as never)

    await expect(
      listAccessibleProjectIds(platformUser(), 'default', 'backups:read'),
    ).resolves.toEqual(['proj_pitch'])

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pm.role = ANY($4::text[])'),
      ['default', 25, 'user_pitchetch', ['project_admin', 'database_admin']],
    )
  })
})
