import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/project-auth/project-device-wipe.service.js', () => ({
  registerProjectDeviceWipeBinding: vi.fn(),
  queryProjectDeviceWipeMandates: vi.fn(),
  acknowledgeProjectDeviceWipeMandate: vi.fn(),
  getProjectDeviceWipeConfig: vi.fn(),
  updateProjectDeviceWipeConfig: vi.fn(),
  listProjectDeviceWipeVerificationKeys: vi.fn(),
  rotateProjectDeviceWipeSigningKey: vi.fn(),
  retireProjectDeviceWipeSigningKey: vi.fn(),
}))
vi.mock('../../apps/api/src/lib/project-authorization.js', () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  assertProjectCapability: vi.fn(),
}))

import * as controller from '../../apps/api/src/modules/project-auth/project-device-wipe.controller.js'
import {
  queryProjectDeviceWipeMandates,
  registerProjectDeviceWipeBinding,
} from '../../apps/api/src/modules/project-auth/project-device-wipe.service.js'

function replyStub() {
  const reply: Record<string, unknown> = {}
  reply.status = vi.fn((code: number) => {
    reply.statusCode = code
    return reply
  })
  reply.send = vi.fn((payload: unknown) => {
    reply.payload = payload
    return reply
  })
  return reply
}

const projectUser = {
  kind: 'project_user',
  sub: '00000000-0000-4000-8000-000000000001',
  projectId: 'proj_1',
  authType: 'project_user',
  role: 'authenticated',
  provider: 'trusted_backend',
}

describe('project device wipe controller', () => {
  beforeEach(() => vi.clearAllMocks())

  it('derives registration ownership only from the same-project Session', async () => {
    vi.mocked(registerProjectDeviceWipeBinding).mockResolvedValue({} as never)
    const reply = replyStub()
    await controller.registerBinding({
      params: { projectId: 'proj_1' },
      headers: { 'idempotency-key': '00000000-0000-4000-8000-000000000602' },
      body: { bindingIdentity: 'A'.repeat(32), bindingRevision: 7 },
      user: projectUser,
    } as never, reply as never)

    expect(registerProjectDeviceWipeBinding).toHaveBeenCalledWith({
      projectId: 'proj_1',
      projectUserId: projectUser.sub,
      idempotencyKey: '00000000-0000-4000-8000-000000000602',
      bindingIdentity: 'A'.repeat(32),
      bindingRevision: 7,
    })
  })

  it('rejects cross-project registration and client-selected users', async () => {
    const crossProjectReply = replyStub()
    await controller.registerBinding({
      params: { projectId: 'proj_2' },
      headers: { 'idempotency-key': '00000000-0000-4000-8000-000000000602' },
      body: { bindingIdentity: 'A'.repeat(32), bindingRevision: 7 },
      user: projectUser,
    } as never, crossProjectReply as never)
    expect(crossProjectReply.statusCode).toBe(403)

    const selectedUserReply = replyStub()
    await controller.registerBinding({
      params: { projectId: 'proj_1' },
      headers: { 'idempotency-key': '00000000-0000-4000-8000-000000000602' },
      body: { bindingIdentity: 'A'.repeat(32), bindingRevision: 7, userId: 'victim' },
      user: projectUser,
    } as never, selectedUserReply as never)
    expect(selectedUserReply.statusCode).toBe(400)
    expect(registerProjectDeviceWipeBinding).not.toHaveBeenCalled()
  })

  it('queries mandates using only the dedicated binding credential', async () => {
    vi.mocked(queryProjectDeviceWipeMandates).mockResolvedValue({ mandates: [] })
    const reply = replyStub()
    await controller.queryMandates({
      params: { projectId: 'proj_1', bindingHandle: 'dwb_12345678901234567890123456789012' },
      headers: { 'x-druvia-binding-token': 'L'.repeat(43) },
    } as never, reply as never)

    expect(queryProjectDeviceWipeMandates).toHaveBeenCalledWith({
      projectId: 'proj_1',
      bindingHandle: 'dwb_12345678901234567890123456789012',
      bindingLookupToken: 'L'.repeat(43),
    })
  })

  it('requires a Platform Session for config management', async () => {
    const reply = replyStub()
    await controller.updateConfig({
      params: { projectId: 'proj_1' },
      body: { enabled: true },
      user: projectUser,
    } as never, reply as never)

    expect(reply.statusCode).toBe(401)
  })
})
