import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  client, poolConnect, executeContract, inspectContract,
  replayDeviceWipeRegistrations, replayDeviceWipeReceipts,
} = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  poolConnect: vi.fn(),
  executeContract: vi.fn(),
  inspectContract: vi.fn(),
  replayDeviceWipeRegistrations: vi.fn(),
  replayDeviceWipeReceipts: vi.fn(),
}))

vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: { connect: poolConnect, query: vi.fn() },
}))

vi.mock('../../apps/api/src/config/index.js', () => ({
  config: {
    deviceWipe: { restoreHookStatementTimeoutMs: 30000 },
  },
}))

vi.mock('../../apps/api/src/modules/project-auth/project-account-deletion.service.js', () => ({
  executeAccountDeletionCleanupContract: executeContract,
  inspectAccountDeletionCleanupContract: inspectContract,
}))

vi.mock('../../apps/api/src/modules/project-auth/project-device-wipe-restore.service.js', () => ({
  replayProjectDeviceWipeRegistrations: replayDeviceWipeRegistrations,
  replayProjectDeviceWipeReceipts: replayDeviceWipeReceipts,
}))

import { replayProjectAccountDeletionFences } from '../../apps/api/src/modules/project-auth/project-account-deletion-restore.service.js'

describe('project account deletion restore replay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    poolConnect.mockResolvedValue(client)
    executeContract.mockResolvedValue(undefined)
    replayDeviceWipeRegistrations.mockResolvedValue(undefined)
    replayDeviceWipeReceipts.mockResolvedValue(undefined)
    inspectContract.mockResolvedValue({
      schemaName: 'dru_default_pitchetch',
      functionName: 'druvia_delete_project_user_data',
      contractHash: 'b'.repeat(64),
    })
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_project_runtime_gates')) {
        return { rows: [{ exists: true }], rowCount: 1 }
      }
      if (sql.includes('FROM druvia_project_account_deletions operation')) {
        return {
          rows: [{
            deletion_id: '05558e52-357a-485b-920a-0ab441a2ad96',
            project_schema: 'dru_default_pitchetch',
            project_user_id: 'user_1',
            cleanup_function: 'druvia_delete_project_user_data',
            cleanup_contract_hash: 'a'.repeat(64),
          }],
          rowCount: 1,
        }
      }
      if (sql.includes(' AS result')) {
        return { rows: [{ result: { completed: true } }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
  })

  it('replays every accepted fence, including operations still in a later cleanup phase', async () => {
    await replayProjectAccountDeletionFences('proj_1', 'backup_1')

    const operationQuery = client.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('FROM druvia_project_account_deletions operation'))
    expect(operationQuery).toContain(
      "operation.status IN ('accepted', 'processing', 'attention_required', 'completed')",
    )
    expect(executeContract).toHaveBeenCalledWith(client, {
      schemaName: 'dru_default_pitchetch',
      functionName: 'druvia_delete_project_user_data',
      contractHash: 'b'.repeat(64),
      projectUserId: 'user_1',
      deletionId: '05558e52-357a-485b-920a-0ab441a2ad96',
    })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(replayDeviceWipeRegistrations).toHaveBeenCalledWith(client, 'proj_1')
    expect(replayDeviceWipeReceipts).toHaveBeenCalledWith(client, 'proj_1')
    expect(replayDeviceWipeRegistrations.mock.invocationCallOrder[0]).toBeLessThan(
      executeContract.mock.invocationCallOrder[0]!,
    )
    expect(executeContract.mock.invocationCallOrder[0]).toBeLessThan(
      replayDeviceWipeReceipts.mock.invocationCallOrder[0]!,
    )
  })

  it('does not clear the restore gate when device wipe receipt replay fails', async () => {
    replayDeviceWipeReceipts.mockRejectedValueOnce(new Error('DEVICE_WIPE_RECEIPT_REPLAY_REQUIRED'))

    await expect(replayProjectAccountDeletionFences('proj_1', 'backup_1')).rejects.toThrow(
      'DEVICE_WIPE_RECEIPT_REPLAY_REQUIRED',
    )

    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining(
      'DELETE FROM druvia_project_runtime_gates',
    ), expect.anything())
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('does not run deletion cleanup or clear the gate when binding replay fails', async () => {
    replayDeviceWipeRegistrations.mockRejectedValueOnce(
      new Error('DEVICE_WIPE_BINDING_REPLAY_REQUIRED'),
    )

    await expect(replayProjectAccountDeletionFences('proj_1', 'backup_1')).rejects.toThrow(
      'DEVICE_WIPE_BINDING_REPLAY_REQUIRED',
    )

    expect(executeContract).not.toHaveBeenCalled()
    expect(replayDeviceWipeReceipts).not.toHaveBeenCalled()
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining(
      'DELETE FROM druvia_project_runtime_gates',
    ), expect.anything())
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('keeps the restore gate and classifies a device wipe Hook timeout for recovery', async () => {
    replayDeviceWipeRegistrations.mockRejectedValueOnce(
      Object.assign(new Error('binding replay required'), {
        code: 'DEVICE_WIPE_BINDING_REPLAY_REQUIRED',
        cause: Object.assign(new Error('statement timeout'), { code: '57014' }),
      }),
    )

    await expect(replayProjectAccountDeletionFences('proj_1', 'backup_1')).rejects.toMatchObject({
      code: 'DEVICE_WIPE_RESTORE_TIMEOUT',
    })

    expect(client.query).toHaveBeenCalledWith(
      "SELECT set_config('statement_timeout', $1, true)",
      ['30000ms'],
    )
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining(
      'DELETE FROM druvia_project_runtime_gates',
    ), expect.anything())
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('uses the validated hook restored with an older backup instead of a later operation hash', async () => {
    await replayProjectAccountDeletionFences('proj_1', 'backup_1')

    expect(inspectContract).toHaveBeenCalledWith(client, 'proj_1')
    expect(executeContract).toHaveBeenCalledWith(client, expect.objectContaining({
      contractHash: 'b'.repeat(64),
    }))
  })
})
