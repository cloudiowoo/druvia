import { beforeEach, describe, expect, it, vi } from 'vitest'

const { withProjectLock, connect, clientQuery, release } = vi.hoisted(() => ({
  withProjectLock: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}))

vi.mock('../../apps/api/src/db/index.js', () => ({ pool: { connect } }))
vi.mock('../../apps/api/src/modules/table/table.service.js', () => ({ trackTableInHasura: vi.fn() }))
vi.mock('../../apps/api/src/modules/realtime/realtime.service.js', () => ({ hasuraMetadataRequest: vi.fn() }))
vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  withProjectDataAccessMutationLock: withProjectLock,
}))

import {
  createEnvironment,
  deleteEnvironment,
} from '../../apps/api/src/modules/environment/environment.service.js'

describe('environment deletion migration lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withProjectLock.mockResolvedValue(true)
    connect.mockResolvedValue({ query: clientQuery, release })
  })

  it('uses the deployment-wide exclusive project lock for non-production deletion', async () => {
    await expect(deleteEnvironment('proj_1', 'staging')).resolves.toBe(true)

    expect(withProjectLock).toHaveBeenCalledWith(
      'proj_1', expect.any(Function), { globalMode: 'exclusive' }
    )
  })

  it('rejects production before acquiring a deletion lock', async () => {
    await expect(deleteEnvironment('proj_1', 'prod')).rejects.toThrow('Cannot delete production environment')
    expect(withProjectLock).not.toHaveBeenCalled()
  })

  it('rejects an environment schema already assigned to another project before creating it', async () => {
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ schema_name: 'dru_default_x' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ assigned: true, schema_exists: true }] })

    await expect(createEnvironment('proj_a', 'dev')).rejects.toMatchObject({
      code: 'ENVIRONMENT_SCHEMA_CONFLICT',
    })

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      ['dru_default_x_dev'],
    )
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('CREATE SCHEMA'),
    )
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK')
    expect(release).toHaveBeenCalled()
  })
})
