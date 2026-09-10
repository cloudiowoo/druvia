import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/project-auth/project-account-deletion.service.js', () => ({
  createAccountDeletionIntent: vi.fn(),
  confirmAccountDeletion: vi.fn(),
  getAccountDeletionStatus: vi.fn(),
  getAccountDeletionConfig: vi.fn(),
  updateAccountDeletionConfig: vi.fn(),
}))

vi.mock('../../apps/api/src/lib/project-authorization.js', () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  assertProjectCapability: vi.fn(),
}))

import * as controller from '../../apps/api/src/modules/project-auth/project-account-deletion.controller.js'
import {
  confirmAccountDeletion,
  createAccountDeletionIntent,
  getAccountDeletionStatus,
} from '../../apps/api/src/modules/project-auth/project-account-deletion.service.js'

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
  sub: 'user_1',
  projectId: 'proj_1',
  authType: 'project_user',
  role: 'authenticated',
  provider: 'apple',
}

describe('project account deletion controller', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects a client-selected deletion target', async () => {
    const reply = replyStub()
    await controller.createIntent({
      params: { projectId: 'proj_1' },
      headers: { 'idempotency-key': '5edb1d3c-70d7-49d4-a86a-5d7aa71c4f2e' },
      body: { userId: 'victim' },
      user: projectUser,
    } as never, reply as never)

    expect(reply.statusCode).toBe(400)
    expect(createAccountDeletionIntent).not.toHaveBeenCalled()
  })

  it('rejects a Project Session from another project', async () => {
    const reply = replyStub()
    await controller.createIntent({
      params: { projectId: 'proj_other' },
      headers: { 'idempotency-key': '5edb1d3c-70d7-49d4-a86a-5d7aa71c4f2e' },
      body: {},
      user: projectUser,
    } as never, reply as never)

    expect(reply.statusCode).toBe(403)
    expect(createAccountDeletionIntent).not.toHaveBeenCalled()
  })

  it('derives the deletion target only from the verified Project Session', async () => {
    vi.mocked(createAccountDeletionIntent).mockResolvedValue({
      deletionId: '05558e52-357a-485b-920a-0ab441a2ad96',
      statusToken: 'token',
      reauthNonce: 'nonce',
      status: 'pending_confirmation',
      intentExpiresAt: '2026-09-10T01:00:00.000Z',
    })
    const reply = replyStub()
    await controller.createIntent({
      params: { projectId: 'proj_1' },
      headers: { 'idempotency-key': '5edb1d3c-70d7-49d4-a86a-5d7aa71c4f2e' },
      body: {},
      user: projectUser,
    } as never, reply as never)

    expect(createAccountDeletionIntent).toHaveBeenCalledWith({
      projectId: 'proj_1',
      projectUserId: 'user_1',
      idempotencyKey: '5edb1d3c-70d7-49d4-a86a-5d7aa71c4f2e',
    })
  })

  it('allows status-token-only confirm replay without granting a project actor', async () => {
    vi.mocked(confirmAccountDeletion).mockResolvedValue({
      deletionId: '05558e52-357a-485b-920a-0ab441a2ad96',
      status: 'completed',
      phase: 'completed',
      acceptedAt: '2026-09-10T00:00:00.000Z',
      dataDeletionDeadlineAt: '2026-09-11T00:00:00.000Z',
      localWipeRequired: true,
      providerRevocationPending: false,
      completedAt: '2026-09-10T00:01:00.000Z',
    })
    const reply = replyStub()
    await controller.confirm({
      params: { projectId: 'proj_1', deletionId: '05558e52-357a-485b-920a-0ab441a2ad96' },
      headers: { 'x-druvia-deletion-token': 'status-token' },
      body: {},
    } as never, reply as never)

    expect(confirmAccountDeletion).toHaveBeenCalledWith(expect.objectContaining({
      projectUserId: undefined,
      statusToken: 'status-token',
      credential: undefined,
    }))
    expect(reply.statusCode).toBe(202)
  })

  it('reads status only from the deletion credential header', async () => {
    vi.mocked(getAccountDeletionStatus).mockResolvedValue({} as never)
    const reply = replyStub()
    await controller.status({
      params: { projectId: 'proj_1', deletionId: '05558e52-357a-485b-920a-0ab441a2ad96' },
      headers: { 'x-druvia-deletion-token': 'status-token' },
    } as never, reply as never)

    expect(getAccountDeletionStatus).toHaveBeenCalledWith({
      projectId: 'proj_1',
      deletionId: '05558e52-357a-485b-920a-0ab441a2ad96',
      statusToken: 'status-token',
    })
  })
})
