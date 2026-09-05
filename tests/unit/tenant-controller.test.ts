import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/tenant/tenant.service.js', () => ({
  deleteTenant: vi.fn(),
  getTenantById: vi.fn(),
  listAccessibleTenants: vi.fn(),
}))

import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js'
import { deleteTenant, getTenant, listTenants } from '../../apps/api/src/modules/tenant/tenant.controller.js'

function replyStub() {
  const reply = { status: vi.fn(), send: vi.fn() }
  reply.status.mockReturnValue(reply)
  reply.send.mockReturnValue(reply)
  return reply
}

describe('tenant deletion migration guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns no content after a successful cascade', async () => {
    vi.mocked(tenantService.deleteTenant).mockResolvedValue(true)
    const reply = replyStub()

    await deleteTenant({ params: { tenantId: 'tenant_1' } } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(204)
  })

  it('returns not found when the tenant does not exist', async () => {
    vi.mocked(tenantService.deleteTenant).mockResolvedValue(false)
    const reply = replyStub()

    await deleteTenant({ params: { tenantId: 'missing' } } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(404)
  })

  it('maps only the named in-flight migration delete guard to a stable conflict', async () => {
    vi.mocked(tenantService.deleteTenant).mockRejectedValue({
      code: '55006',
      constraint: 'druvia_data_access_migrations_inflight_delete_guard',
    })
    const reply = replyStub()

    await deleteTenant({ params: { tenantId: 'tenant_1' } } as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(409)
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'DATA_ACCESS_MIGRATION_IN_PROGRESS' }),
    }))
  })

  it('does not hide unrelated database failures', async () => {
    const failure = Object.assign(new Error('database unavailable'), { code: '55006' })
    vi.mocked(tenantService.deleteTenant).mockRejectedValue(failure)

    await expect(deleteTenant(
      { params: { tenantId: 'tenant_1' } } as never,
      replyStub() as never
    )).rejects.toBe(failure)
  })
})

describe('tenant member-safe projection', () => {
  const tenant = {
    id: 1,
    tenantId: 'default',
    alias: 'default',
    name: 'Default Tenant',
    ownerUid: 1,
    plan: 'enterprise',
    settings: { internal: true },
    status: 'active',
    description: 'Workspace',
    storageLimit: 100,
    projectLimit: 10,
    userLimit: 20,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  }

  beforeEach(() => vi.clearAllMocks())

  it('omits owner, settings and quotas for a project-only workspace member', async () => {
    vi.mocked(tenantService.getTenantById).mockResolvedValue(tenant as never)
    const reply = replyStub()

    await getTenant({
      params: { tenantId: 'default' },
      tenantAccess: { tenantId: 'default', isWorkspaceOwner: false, isSuperAdmin: false },
    } as never, reply as never)

    const data = (vi.mocked(reply.send).mock.calls[0][0] as { data: Record<string, unknown> }).data
    expect(data).toMatchObject({ tenantId: 'default', alias: 'default', name: 'Default Tenant' })
    expect(data).not.toHaveProperty('ownerUid')
    expect(data).not.toHaveProperty('settings')
    expect(data).not.toHaveProperty('storageLimit')
  })

  it('keeps the full tenant response for workspace owners', async () => {
    vi.mocked(tenantService.getTenantById).mockResolvedValue(tenant as never)
    const reply = replyStub()

    await getTenant({
      params: { tenantId: 'default' },
      tenantAccess: { tenantId: 'default', isWorkspaceOwner: true, isSuperAdmin: false },
    } as never, reply as never)

    expect(reply.send).toHaveBeenCalledWith({ success: true, data: tenant })
  })

  it('projects each workspace list row according to current access', async () => {
    vi.mocked(tenantService.listAccessibleTenants).mockResolvedValue([
      { tenant, fullAccess: false },
    ] as never)
    const reply = replyStub()

    await listTenants({
      query: {},
      user: { kind: 'platform_user', uid: 2, userId: 'user_2', role: 'admin' },
    } as never, reply as never)

    const payload = vi.mocked(reply.send).mock.calls[0][0] as { data: Array<Record<string, unknown>> }
    expect(payload.data[0]).toMatchObject({ tenantId: 'default', name: 'Default Tenant' })
    expect(payload.data[0]).not.toHaveProperty('settings')
    expect(payload.data[0]).not.toHaveProperty('ownerUid')
  })
})
