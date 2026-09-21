import { describe, expect, it, vi } from 'vitest'
import { assertSupportedDatabaseMigrationVersion } from '../../apps/api/src/db/migration-compatibility.js'

describe('database migration compatibility', () => {
  it('accepts a database at the API migration ceiling', async () => {
    const query = vi.fn(async () => ({ rows: [{ version: 28 }] }))
    await expect(assertSupportedDatabaseMigrationVersion({ query }, 28)).resolves.toBeUndefined()
  })

  it('rejects a database newer than the API understands', async () => {
    const query = vi.fn(async () => ({ rows: [{ version: 29 }] }))
    await expect(assertSupportedDatabaseMigrationVersion({ query }, 28))
      .rejects.toThrow(/newer than this API supports/i)
  })

  it('rejects a database older than the API requires', async () => {
    const query = vi.fn(async () => ({ rows: [{ version: 27 }] }))
    await expect(assertSupportedDatabaseMigrationVersion({ query }, 28, 28))
      .rejects.toThrow(/older than this API requires/i)
  })
})
