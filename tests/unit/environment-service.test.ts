import { beforeEach, describe, expect, it, vi } from 'vitest'

const { withProjectLock } = vi.hoisted(() => ({ withProjectLock: vi.fn() }))

vi.mock('../../apps/api/src/db/index.js', () => ({ pool: {} }))
vi.mock('../../apps/api/src/modules/table/table.service.js', () => ({ trackTableInHasura: vi.fn() }))
vi.mock('../../apps/api/src/modules/realtime/realtime.service.js', () => ({ hasuraMetadataRequest: vi.fn() }))
vi.mock('../../apps/api/src/modules/data-access/data-access-mutation-lock.js', () => ({
  withProjectDataAccessMutationLock: withProjectLock,
}))

import { deleteEnvironment } from '../../apps/api/src/modules/environment/environment.service.js'

describe('environment deletion migration lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withProjectLock.mockResolvedValue(true)
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
})
