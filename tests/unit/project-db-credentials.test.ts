import { beforeEach, describe, expect, it, vi } from 'vitest'

const { client, poolConnect, projectLock, deviceWipeGuard } = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  poolConnect: vi.fn(),
  projectLock: vi.fn(),
  deviceWipeGuard: vi.fn(),
}))

vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: { connect: poolConnect },
  queryOne: vi.fn(),
}))

vi.mock('../../apps/api/src/config/index.js', () => ({
  config: { database: { host: 'localhost', port: 5432, database: 'druvia' } },
}))

vi.mock('../../apps/api/src/modules/project-auth/project-identity.repository.js', () => ({
  acquireProjectAuthProjectLock: projectLock,
}))

vi.mock('../../apps/api/src/modules/project-auth/project-device-wipe.service.js', () => ({
  assertProjectDeviceWipeProjectDeletionAllowed: deviceWipeGuard,
}))

import { dropProjectDbUser } from '../../apps/api/src/modules/project/db-credentials.service.js'
import { ProjectDeviceWipeError } from '../../apps/api/src/modules/project-auth/project-device-wipe.types.js'

describe('project database credentials lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    poolConnect.mockResolvedValue(client)
    projectLock.mockResolvedValue(undefined)
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_projects')) {
        return { rows: [{ db_user: 'dru_project_user', schema_name: 'dru_project' }] }
      }
      return { rows: [] }
    })
  })

  it('blocks database-user ownership changes while device wipe state exists', async () => {
    deviceWipeGuard.mockRejectedValueOnce(new ProjectDeviceWipeError(
      'DEVICE_WIPE_DECOMMISSION_REQUIRED',
      'Device wipe state exists',
      409,
    ))

    await expect(dropProjectDbUser('proj_1')).rejects.toMatchObject({
      code: 'DEVICE_WIPE_DECOMMISSION_REQUIRED',
      statusCode: 409,
    })

    expect(projectLock).toHaveBeenCalledWith(client, 'proj_1')
    expect(deviceWipeGuard).toHaveBeenCalledWith('proj_1', client)
    expect(client.query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toMatch(
      /REASSIGN OWNED|DROP OWNED|DROP ROLE/,
    )
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('uses the caller connection so full project deletion does not reacquire on another session', async () => {
    const outerClient = { query: vi.fn(), release: vi.fn() }
    outerClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM druvia_projects')) return { rows: [] }
      return { rows: [] }
    })

    await expect(dropProjectDbUser('proj_1', outerClient as never)).resolves.toBe(false)

    expect(poolConnect).not.toHaveBeenCalled()
    expect(projectLock).toHaveBeenCalledWith(outerClient, 'proj_1')
    expect(outerClient.release).not.toHaveBeenCalled()
  })
})
