import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../apps/api/src/modules/realtime/realtime.service.js', () => ({
  hasuraMetadataRequest: vi.fn(),
}))

import { hasuraMetadataRequest } from '../../apps/api/src/modules/realtime/realtime.service.js'
import { applyHasuraMetadataCommands } from '../../apps/api/src/modules/data-access/hasura-metadata-bulk.js'

const commands = [{
  type: 'pg_create_select_permission',
  args: { source: 'default', role: 'project_user' },
}]

describe('Hasura metadata permission batches', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the atomic API when the running Hasura supports the command', async () => {
    vi.mocked(hasuraMetadataRequest).mockResolvedValueOnce([] as never)

    await applyHasuraMetadataCommands(commands)

    expect(hasuraMetadataRequest).toHaveBeenCalledOnce()
    expect(hasuraMetadataRequest).toHaveBeenCalledWith('bulk_atomic', commands)
  })

  it('falls back only for the exact unsupported atomic-command response', async () => {
    vi.mocked(hasuraMetadataRequest)
      .mockRejectedValueOnce(new Error('Hasura metadata request failed: Bulk atomic does not support this command'))
      .mockResolvedValueOnce([] as never)

    await applyHasuraMetadataCommands(commands)

    expect(hasuraMetadataRequest).toHaveBeenNthCalledWith(1, 'bulk_atomic', commands)
    expect(hasuraMetadataRequest).toHaveBeenNthCalledWith(2, 'bulk', commands)
  })

  it('does not retry validation or transport failures through a weaker mode', async () => {
    vi.mocked(hasuraMetadataRequest).mockRejectedValueOnce(new Error('permission validation failed'))

    await expect(applyHasuraMetadataCommands(commands)).rejects.toThrow('permission validation failed')
    expect(hasuraMetadataRequest).toHaveBeenCalledOnce()
  })
})
