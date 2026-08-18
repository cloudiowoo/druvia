import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/tenant/tenant.service.js', () => ({
  deleteTenant: vi.fn(),
}))

import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js'
import { deleteTenant } from '../../apps/api/src/modules/tenant/tenant.controller.js'

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
