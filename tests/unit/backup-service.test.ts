import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query, queryOne, projectLock, schemaLock } = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  projectLock: vi.fn(),
  schemaLock: vi.fn(),
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

import {
  listBackups,
  listBackupsForProjects,
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
