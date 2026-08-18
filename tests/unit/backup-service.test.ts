import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryOne, projectLock, schemaLock } = vi.hoisted(() => ({
  queryOne: vi.fn(),
  projectLock: vi.fn(),
  schemaLock: vi.fn(),
}))

vi.mock('../../apps/api/src/db/index.js', () => ({ query: vi.fn(), queryOne, pool: {} }))
vi.mock('../../apps/api/src/adapters/storage/index.js', () => ({ getDefaultStorageAdapter: vi.fn() }))
vi.mock('../../apps/api/src/lib/logger.js', () => ({
  createApiLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn() })),
}))
vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  withProjectDataAccessMutationLock: projectLock,
  withSchemaDataAccessMutationLock: schemaLock,
}))

import { restoreBackup } from '../../apps/api/src/modules/backup/backup.service.js'

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
    projectLock.mockResolvedValue(undefined)
    schemaLock.mockResolvedValue(undefined)
  })

  it('serializes project backups with the deployment-wide exclusive lock', async () => {
    queryOne.mockResolvedValue(backupRow('proj_1'))

    await restoreBackup('bkp_1')

    expect(projectLock).toHaveBeenCalledWith(
      'proj_1', expect.any(Function), { globalMode: 'exclusive' }
    )
    expect(schemaLock).not.toHaveBeenCalled()
  })

  it('serializes legacy schema-only backups through schema resolution', async () => {
    queryOne.mockResolvedValue(backupRow(null))

    await restoreBackup('bkp_1')

    expect(schemaLock).toHaveBeenCalledWith(
      'dru_project', expect.any(Function), { globalMode: 'exclusive' }
    )
    expect(projectLock).not.toHaveBeenCalled()
  })
})
