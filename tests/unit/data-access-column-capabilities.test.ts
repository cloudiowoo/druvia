import { describe, expect, it } from 'vitest'
import { buildTableColumnCapabilities } from '../../apps/api/src/modules/data-access/data-access-column-capabilities.js'

describe('data access column capabilities', () => {
  it('classifies generated and identity columns per write operation', () => {
    const capabilities = buildTableColumnCapabilities([
      tableColumn('title'),
      tableColumn('slug', { defaultValue: 'generate_slug()' }),
      tableColumn('computed', { isGenerated: true }),
      tableColumn('system_id', { isIdentity: true, identityGeneration: 'ALWAYS' }),
      tableColumn('import_id', { isIdentity: true, identityGeneration: 'BY DEFAULT' }),
    ])

    expect(capabilities).toEqual({
      readableColumns: ['title', 'slug', 'computed', 'system_id', 'import_id'],
      insertableColumns: ['title', 'slug', 'import_id'],
      updateableColumns: ['title', 'slug', 'import_id'],
    })
  })
})

function tableColumn(
  name: string,
  overrides: Partial<Parameters<typeof buildTableColumnCapabilities>[0][number]> = {}
): Parameters<typeof buildTableColumnCapabilities>[0][number] {
  return {
    name,
    type: 'text',
    nullable: false,
    defaultValue: null,
    isPrimaryKey: false,
    isGenerated: false,
    isIdentity: false,
    identityGeneration: null,
    ...overrides,
  }
}
