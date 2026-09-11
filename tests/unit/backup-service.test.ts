import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  query, queryOne, projectLock, schemaLock, projectAuthLock, replayFences, markRecovery,
} = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  projectLock: vi.fn(),
  schemaLock: vi.fn(),
  projectAuthLock: vi.fn(),
  replayFences: vi.fn(),
  markRecovery: vi.fn(),
}))

vi.mock('../../apps/api/src/db/index.js', () => ({ query, queryOne, pool: {} }))
vi.mock('../../apps/api/src/adapters/storage/index.js', () => ({ getDefaultStorageAdapter: vi.fn() }))
vi.mock('../../apps/api/src/lib/logger.js', () => ({
  createApiLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn() })),
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  withProjectDataAccessMutationLock: projectLock,
  withSchemaDataAccessMutationLock: schemaLock,
}))
vi.mock('../../apps/api/src/modules/project-auth/project-identity.repository.js', () => ({
  withProjectAuthProjectLock: projectAuthLock,
}))
vi.mock('../../apps/api/src/modules/project-auth/project-account-deletion-restore.service.js', () => ({
  beginProjectRestoreGate: vi.fn(),
  markProjectRestoreRecoveryRequired: markRecovery,
  replayProjectAccountDeletionFences: replayFences,
}))

import {
  listBackups,
  listBackupsForProjects,
  projectRestoreRecoveryReason,
  restoreBackup,
} from '../../apps/api/src/modules/backup/backup.service.js'

function backupRow(projectId: string | null) {
  return {
    id: 1, backup_id: 'bkp_1', tenant_id: 'tenant_1', project_id: projectId,
    schema_name: 'dru_project', storage_key: 'backups/bkp_1.dump', size_bytes: 1,
    tables_count: 1, tables_list: ['orders'], status: 'completed', error_message: null,
    created_by: 1, created_at: new Date(), completed_at: new Date(),
  }
}

describe('backup restore migration lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.mockReset()
    queryOne.mockReset()
    projectLock.mockResolvedValue(undefined)
    schemaLock.mockResolvedValue(undefined)
    projectAuthLock.mockResolvedValue(undefined)
    replayFences.mockResolvedValue(undefined)
    markRecovery.mockResolvedValue(undefined)
  })

  it('serializes project backups with the deployment-wide exclusive lock', async () => {
    queryOne.mockResolvedValue(backupRow('proj_1'))

    await restoreBackup('bkp_1')

    expect(projectLock).toHaveBeenCalledWith(
      'proj_1', expect.any(Function), { globalMode: 'exclusive' }
    )
    expect(schemaLock).not.toHaveBeenCalled()
  })

  it('holds the project auth lock for the restore callback', async () => {
    const lockClient = { query: vi.fn(), release: vi.fn() }
    queryOne.mockResolvedValue(backupRow('proj_1'))
    projectLock.mockImplementation(async (_projectId, callback) => callback(lockClient))

    await restoreBackup('bkp_1')

    expect(projectAuthLock).toHaveBeenCalledWith(lockClient, 'proj_1', expect.any(Function))
  })

  it('serializes legacy schema-only backups through schema resolution', async () => {
    queryOne
      .mockResolvedValueOnce(backupRow(null))
      .mockResolvedValueOnce({ project_id: 'proj_legacy' })

    await restoreBackup('bkp_1')

    expect(projectLock).toHaveBeenCalledWith(
      'proj_legacy', expect.any(Function), { globalMode: 'exclusive' }
    )
    expect(schemaLock).not.toHaveBeenCalled()
  })

  it('rejects legacy schema-only restore when the schema cannot be mapped to one project', async () => {
    queryOne
      .mockResolvedValueOnce(backupRow(null))
      .mockResolvedValueOnce(null)

    await expect(restoreBackup('bkp_1')).rejects.toThrow('BACKUP_SCOPE_MISMATCH')

    expect(projectLock).not.toHaveBeenCalled()
    expect(schemaLock).not.toHaveBeenCalled()
  })

  it('classifies device wipe replay failures with a dedicated recovery reason', () => {
    const error = new Error('device wipe replay failed')
    error.name = 'ProjectDeviceWipeRestoreError'
    Object.assign(error, { code: 'DEVICE_WIPE_RECEIPT_REPLAY_REQUIRED' })

    expect(projectRestoreRecoveryReason(error)).toBe('DEVICE_WIPE_RECEIPT_REPLAY_REQUIRED')
    Object.assign(error, { code: 'DEVICE_WIPE_BINDING_REPLAY_REQUIRED' })
    expect(projectRestoreRecoveryReason(error)).toBe('DEVICE_WIPE_BINDING_REPLAY_REQUIRED')
    Object.assign(error, { code: 'DEVICE_WIPE_RESTORE_TIMEOUT' })
    expect(projectRestoreRecoveryReason(error)).toBe('DEVICE_WIPE_RESTORE_TIMEOUT')
    expect(projectRestoreRecoveryReason(new Error('account replay failed'))).toBe(
      'ACCOUNT_DELETION_FENCE_REPLAY_REQUIRED',
    )
  })

  it('filters workspace backup listings by unique matching schema scope before pagination', async () => {
    query.mockResolvedValue([backupRow(null)])

    const backups = await listBackups('tenant_1', 25, 5)

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/HAVING COUNT\(DISTINCT project_id\) = 1[\s\S]*scope\.tenant_id = b\.tenant_id[\s\S]*b\.project_id IS NULL OR b\.project_id = scope\.project_id[\s\S]*LIMIT \$2 OFFSET \$3/),
      ['tenant_1', 25, 5],
    )
    expect(backups[0]).not.toHaveProperty('storageKey')
    expect(backups[0]).not.toHaveProperty('errorMessage')
    expect(backups[0]).not.toHaveProperty('tablesList')
    expect(backups[0]).not.toHaveProperty('createdBy')
  })

  it('filters member backup listings by unique matching project scope before pagination', async () => {
    query.mockResolvedValue([backupRow('proj_1')])

    await listBackupsForProjects('tenant_1', ['proj_1'], 10, 2)

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/HAVING COUNT\(DISTINCT project_id\) = 1[\s\S]*scope\.tenant_id = b\.tenant_id[\s\S]*b\.project_id = scope\.project_id[\s\S]*b\.project_id = ANY\(\$2::text\[\]\)[\s\S]*LIMIT \$3 OFFSET \$4/),
      ['tenant_1', ['proj_1'], 10, 2],
    )
  })
})
