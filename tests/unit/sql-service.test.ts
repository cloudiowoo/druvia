import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
}

vi.mock('../../apps/api/src/db/index.js', () => ({
  pool: {
    connect: vi.fn(async () => mockClient),
  },
  query: vi.fn(),
}))

import { importSql } from '../../apps/api/src/modules/sql/sql.service.js'

describe('SQL Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0, fields: [] })
  })

  it('keeps $$ quoted function bodies as a single statement during import', async () => {
    const sql = `
      CREATE OR REPLACE FUNCTION test_sql_import_function()
      RETURNS integer
      LANGUAGE plpgsql
      AS $$
      DECLARE
        value integer := 1;
      BEGIN
        value := value + 1;
        RETURN value;
      END;
      $$;
    `

    const result = await importSql('test_schema', sql)

    expect(result.errors).toHaveLength(0)
    expect(mockClient.query).toHaveBeenCalledTimes(4)
    expect(mockClient.query).toHaveBeenNthCalledWith(3, expect.stringContaining('CREATE OR REPLACE FUNCTION test_sql_import_function()'))
    expect(mockClient.query).toHaveBeenNthCalledWith(3, expect.stringContaining('value integer := 1;'))
    expect(mockClient.query).toHaveBeenNthCalledWith(3, expect.stringContaining('RETURN value;'))
  })

  it('keeps tagged dollar quoted function bodies as a single statement during import', async () => {
    const sql = `
      CREATE OR REPLACE FUNCTION tagged_sql_import_function()
      RETURNS text
      LANGUAGE plpgsql
      AS $func$
      BEGIN
        RETURN 'ok;still-inside';
      END;
      $func$;
    `

    const result = await importSql('test_schema', sql)

    expect(result.errors).toHaveLength(0)
    expect(mockClient.query).toHaveBeenCalledTimes(4)
    expect(mockClient.query).toHaveBeenNthCalledWith(3, expect.stringContaining('CREATE OR REPLACE FUNCTION tagged_sql_import_function()'))
    expect(mockClient.query).toHaveBeenNthCalledWith(3, expect.stringContaining("RETURN 'ok;still-inside';"))
  })

  it('still treats semicolons inside strings as part of the same statement', async () => {
    const sql = `
      CREATE TABLE import_test (id serial primary key, data text);
      INSERT INTO import_test (data) VALUES ('value; with; semicolons');
    `

    const result = await importSql('test_schema', sql)

    expect(result.errors).toHaveLength(0)
    expect(mockClient.query).toHaveBeenCalledTimes(5)
    expect(mockClient.query).toHaveBeenNthCalledWith(3, 'CREATE TABLE import_test (id serial primary key, data text)')
    expect(mockClient.query).toHaveBeenNthCalledWith(4, "INSERT INTO import_test (data) VALUES ('value; with; semicolons')")
  })

  it('executes statements that have leading comments and ignores nested transaction wrappers from imported files', async () => {
    const sql = `
      -- Migration header
      -- Apply manually
      BEGIN;

      -- 1. create function
      CREATE OR REPLACE FUNCTION test_sql_import_function()
      RETURNS integer
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN 1;
      END;
      $$;

      COMMENT ON FUNCTION test_sql_import_function()
      IS 'test comment';

      COMMIT;
    `

    const result = await importSql('test_schema', sql)

    expect(result.errors).toHaveLength(0)
    expect(mockClient.query).toHaveBeenCalledTimes(5)
    expect(mockClient.query).toHaveBeenNthCalledWith(3, expect.stringContaining('CREATE OR REPLACE FUNCTION test_sql_import_function()'))
    expect(mockClient.query).toHaveBeenNthCalledWith(4, expect.stringContaining("COMMENT ON FUNCTION test_sql_import_function()"))
    expect(mockClient.query).toHaveBeenNthCalledWith(5, 'COMMIT')
  })
})
