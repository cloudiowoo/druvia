import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/db/index.js', () => ({
  queryOne: vi.fn(),
}))

import { queryOne } from '../../apps/api/src/db/index.js'
import {
  ProjectRuntimeBlockedError,
  assertProjectRuntimeAvailable,
  assertProjectSessionUsable,
} from '../../apps/api/src/modules/project-auth/project-session-state.js'

describe('project session state', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows a project user before an account deletion is accepted', async () => {
    vi.mocked(queryOne).mockResolvedValue(null)

    await expect(assertProjectSessionUsable({
      projectId: 'proj_123',
      projectUserId: 'user_123',
    })).resolves.toBeUndefined()
  })

  it('blocks old access tokens while or after account deletion runs', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'processing' })

    await expect(assertProjectSessionUsable({
      projectId: 'proj_123',
      projectUserId: 'user_123',
    })).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
      statusCode: 409,
    })
  })

  it('fails closed when the old account reappears after deletion', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'completed' })

    await expect(assertProjectSessionUsable({
      projectId: 'proj_123',
      projectUserId: 'user_123',
    })).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_ATTENTION_REQUIRED',
      statusCode: 503,
    })
  })

  it('blocks an old Apple access token after a disabled-project account-deleted notification', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'attention_required' })

    await expect(assertProjectSessionUsable({
      projectId: 'proj_123',
      projectUserId: 'user_123',
    })).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_ATTENTION_REQUIRED',
      statusCode: 503,
    })

    expect(vi.mocked(queryOne).mock.calls[1]?.[0]).toContain("status = 'deletion_pending'")
  })

  it('blocks every project actor while a restore gate exists', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ status: 'restoring' })

    await expect(assertProjectRuntimeAvailable('proj_123')).rejects.toBeInstanceOf(
      ProjectRuntimeBlockedError,
    )
  })
})
