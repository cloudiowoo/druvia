import { describe, expect, it } from 'vitest'
import { stripMigrationTransactionWrapper } from '../../apps/api/src/cli/migration-sql.js'

describe('migration SQL transaction wrapper handling', () => {
  it('removes a wrapper after leading line and block comments', () => {
    const sql = `-- migration summary
/* deployment note */

BEGIN;

CREATE TABLE example (id INT);

COMMIT;
-- trailing note
`

    const stripped = stripMigrationTransactionWrapper(sql)

    expect(stripped).toContain('-- migration summary')
    expect(stripped).toContain('/* deployment note */')
    expect(stripped).toContain('CREATE TABLE example (id INT);')
    expect(stripped).toContain('-- trailing note')
    expect(stripped).not.toMatch(/(^|\n)\s*BEGIN\s*;/i)
    expect(stripped).not.toMatch(/(^|\n)\s*COMMIT\s*;/i)
  })

  it('leaves an unwrapped migration body intact apart from outer whitespace', () => {
    const sql = '\n-- note\nDO $$ BEGIN RAISE NOTICE \'ok\'; END $$;\n'
    expect(stripMigrationTransactionWrapper(sql)).toBe(sql.trim())
  })

  it('does not treat COMMIT text inside a trailing comment as a wrapper', () => {
    const sql = 'SELECT 1;\n-- COMMIT;'
    expect(stripMigrationTransactionWrapper(sql)).toBe(sql)
  })

  it.each([
    'BEGIN;\nSELECT 1;',
    'SELECT 1;\nCOMMIT;',
  ])('preserves an unmatched transaction boundary in %s', (sql) => {
    expect(stripMigrationTransactionWrapper(sql)).toBe(sql)
  })
})
