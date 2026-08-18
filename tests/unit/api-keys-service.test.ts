import { beforeEach, describe, expect, it, vi } from 'vitest'

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }))

vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: { query: poolQuery },
}))

import { validateApiKey } from '../../apps/api/src/modules/api-keys/api-keys.service.js'

describe('API Key validation identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns stable non-secret key identity from the validation query', async () => {
    poolQuery.mockResolvedValue({
      rows: [{
        id: 41,
        project_id: 'proj_123',
        schema_name: 'dru_123',
        key_prefix: 'dru_fixture1',
      }],
    })

    await expect(validateApiKey('dru_full_secret')).resolves.toEqual({
      valid: true,
      projectId: 'proj_123',
      schemaName: 'dru_123',
      apiKeyId: 41,
      apiKeyPrefix: 'dru_fixture1',
    })

    const [sql, params] = poolQuery.mock.calls[0]
    expect(sql).toContain('ak.id')
    expect(sql).toContain('ak.key_prefix')
    expect(params).not.toContain('dru_full_secret')
    expect(JSON.stringify(await validateApiKey('missing'))).not.toContain('key_hash')
  })

  it('returns only valid false for an unknown key', async () => {
    poolQuery.mockResolvedValue({ rows: [] })

    await expect(validateApiKey('missing')).resolves.toEqual({ valid: false })
  })
})
