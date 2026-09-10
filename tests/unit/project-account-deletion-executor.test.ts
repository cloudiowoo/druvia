import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clientQuery, poolQuery, storageCleanup, projectAuthLock, getAppleAdapter } = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  poolQuery: vi.fn(),
  storageCleanup: vi.fn(),
  projectAuthLock: vi.fn(async (_client, _projectId, callback) => callback()),
  getAppleAdapter: vi.fn(),
}))

vi.mock('../../apps/api/src/config/index.js', () => ({
  config: {
    accountDeletion: {
      executorEnabled: true,
      executorLeaseSeconds: 120,
      executorPollMs: 5000,
      cleanupStatementTimeoutMs: 30000,
    },
  },
}))
vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: {
    connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
    query: poolQuery,
  },
}))
vi.mock('../../apps/api/src/modules/storage/storage.service.js', () => ({
  deleteObjectsOwnedByProjectUser: storageCleanup,
}))
vi.mock('../../apps/api/src/modules/project-auth/project-auth.service.js', () => ({
  getAppleAdapter,
}))
vi.mock('../../apps/api/src/modules/project-auth/project-account-deletion.service.js', () => ({
  executeAccountDeletionCleanupContract: vi.fn(),
}))
vi.mock('../../apps/api/src/modules/project-auth/project-identity.repository.js', () => ({
  acquireProjectAuthIdentityIdLock: vi.fn(),
  withProjectAuthProjectLock: projectAuthLock,
}))
vi.mock('../../apps/api/src/lib/secret-encryption.js', () => ({ decryptSecret: vi.fn() }))
vi.mock('../../apps/api/src/lib/logger.js', () => ({
  createApiLogger: vi.fn(() => ({ warn: vi.fn() })),
}))

import { runAccountDeletionExecutorCycle } from '../../apps/api/src/modules/project-auth/project-account-deletion.executor.js'

describe('project account deletion executor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageCleanup.mockResolvedValue(2)
    poolQuery.mockResolvedValue({ rowCount: 1, rows: [] })
  })

  it('claims and advances a storage cleanup with a lease-bound CAS', async () => {
    clientQuery
      .mockResolvedValueOnce({
        rows: [{
          deletion_id: '05558e52-357a-485b-920a-0ab441a2ad96',
          project_id: 'proj_1',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          deletion_id: '05558e52-357a-485b-920a-0ab441a2ad96',
          project_id: 'proj_1',
          project_schema: 'dru_default_pitchetch',
          project_user_id: 'user_1',
          identity_id: 1,
          cleanup_function: 'druvia_delete_project_user_data',
          cleanup_contract_hash: 'a'.repeat(64),
          phase: 'storage_cleanup',
          lease_token: 'lease_1',
          data_deletion_deadline_at: new Date(Date.now() + 60_000),
          attempt_count: 1,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    await expect(runAccountDeletionExecutorCycle()).resolves.toEqual({ processed: 1 })
    expect(storageCleanup).toHaveBeenCalledWith('proj_1', 'user_1')
    expect(projectAuthLock).toHaveBeenCalledWith(expect.anything(), 'proj_1', expect.any(Function))
    expect(clientQuery.mock.calls[1]?.[0]).toContain('druvia_project_runtime_gates')
    expect(poolQuery).toHaveBeenCalledWith(
      expect.stringMatching(/phase = \$3[\s\S]*lease_token = \$2/),
      ['05558e52-357a-485b-920a-0ab441a2ad96', 'lease_1', 'project_user_cleanup'],
    )
  })

  it('does not automatically claim operations that require operator attention', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    await runAccountDeletionExecutorCycle()

    expect(clientQuery.mock.calls[0]?.[0]).not.toContain("'attention_required'")
  })

  it('retains the failing phase when a deadline-exceeded operation needs attention', async () => {
    storageCleanup.mockRejectedValueOnce(new Error('storage unavailable'))
    clientQuery
      .mockResolvedValueOnce({
        rows: [{
          deletion_id: '05558e52-357a-485b-920a-0ab441a2ad96',
          project_id: 'proj_1',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          deletion_id: '05558e52-357a-485b-920a-0ab441a2ad96',
          project_id: 'proj_1',
          project_schema: 'dru_default_pitchetch',
          project_user_id: 'user_1',
          identity_id: 1,
          cleanup_function: 'druvia_delete_project_user_data',
          cleanup_contract_hash: 'a'.repeat(64),
          phase: 'storage_cleanup',
          lease_token: 'lease_1',
          data_deletion_deadline_at: new Date(Date.now() - 1_000),
          attempt_count: 3,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    await runAccountDeletionExecutorCycle()

    expect(poolQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET status = $3, phase = $4'),
      expect.arrayContaining([
        '05558e52-357a-485b-920a-0ab441a2ad96',
        'lease_1',
        'attention_required',
        'storage_cleanup',
        'ACCOUNT_DELETION_DEADLINE_EXCEEDED',
      ]),
    )
  })

  it('reports unhealthy when a deletion is overdue or needs attention', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{ overdue_operations: '1', attention_required_operations: '1' }],
      rowCount: 1,
    })

    const { getAccountDeletionExecutorHealth } = await import(
      '../../apps/api/src/modules/project-auth/project-account-deletion.executor.js'
    )
    await expect(getAccountDeletionExecutorHealth()).resolves.toEqual({
      healthy: false,
      overdueOperations: 1,
      attentionRequiredOperations: 1,
    })
  })

  it('claims a provider token with a status CAS while holding the project auth lock', async () => {
    getAppleAdapter.mockResolvedValue({ revoke: vi.fn().mockResolvedValue(undefined) })
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 7, project_id: 'proj_1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 7,
          deletion_id: '05558e52-357a-485b-920a-0ab441a2ad96',
          project_id: 'proj_1',
          audience: 'com.example.app',
          refresh_token_encrypted: 'encrypted',
          lease_token: 'lease_1',
          attempt_count: 1,
        }],
      })

    await runAccountDeletionExecutorCycle()

    expect(projectAuthLock).toHaveBeenCalledWith(expect.anything(), 'proj_1', expect.any(Function))
    expect(clientQuery.mock.calls[2]?.[0]).toMatch(
      /token\.id = \$3[\s\S]*token\.status IN \('pending', 'in_flight'\)[\s\S]*token\.lease_until/,
    )
  })
})
