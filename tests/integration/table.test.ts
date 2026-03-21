import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as tableService from '../../apps/api/src/modules/table/table.service.js';

describe('TableService Integration', () => {
  const testSchema = 'test_table_schema';

  beforeAll(async () => {
    // Create test schema
    await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${testSchema}"`);

    // Create _meta_tables for the test schema
    await pool.query(`
      CREATE TABLE "${testSchema}"._meta_tables (
        id SERIAL PRIMARY KEY,
        table_name VARCHAR(128) UNIQUE NOT NULL,
        description TEXT,
        row_count BIGINT DEFAULT 0,
        realtime_enabled BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  });

  beforeEach(async () => {
    // Clean up tables (except _meta_tables)
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name NOT LIKE '\\_%'`,
      [testSchema]
    );
    for (const row of tables.rows) {
      await pool.query(`DROP TABLE IF EXISTS "${testSchema}"."${row.table_name}" CASCADE`);
    }
    await pool.query(`DELETE FROM "${testSchema}"._meta_tables`);
  });

  describe('generateCreateTableDDL', () => {
    it('should generate correct DDL for simple table', () => {
      const ddl = tableService.generateCreateTableDDL(testSchema, {
        name: 'users',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'name', type: 'VARCHAR(255)', nullable: false },
          { name: 'email', type: 'VARCHAR(255)', nullable: true, unique: true },
        ],
      });

      expect(ddl).toContain(`CREATE TABLE "${testSchema}"."users"`);
      expect(ddl).toContain('"id" SERIAL PRIMARY KEY');
      expect(ddl).toContain('"name" VARCHAR(255) NOT NULL');
      expect(ddl).toContain('"email" VARCHAR(255) UNIQUE');
    });

    it('should generate DDL with default values', () => {
      const ddl = tableService.generateCreateTableDDL(testSchema, {
        name: 'posts',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'status', type: 'VARCHAR(20)', defaultValue: "'draft'" },
          { name: 'created_at', type: 'TIMESTAMP', defaultValue: 'NOW()' },
        ],
      });

      expect(ddl).toContain("DEFAULT 'draft'");
      expect(ddl).toContain('DEFAULT NOW()');
    });

    it('should generate DDL with foreign key', () => {
      const ddl = tableService.generateCreateTableDDL(testSchema, {
        name: 'comments',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          {
            name: 'post_id',
            type: 'INT',
            references: { table: 'posts', column: 'id', onDelete: 'CASCADE' },
          },
        ],
      });

      expect(ddl).toContain('REFERENCES "posts"("id") ON DELETE CASCADE');
    });
  });

  describe('createTable', () => {
    it('should create table in schema', async () => {
      await tableService.createTable(testSchema, {
        name: 'products',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'name', type: 'VARCHAR(255)', nullable: false },
          { name: 'price', type: 'DECIMAL(10,2)' },
        ],
      });

      // Verify table exists
      const result = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = $2`,
        [testSchema, 'products']
      );
      expect(result.rows.length).toBe(1);

      // Verify registered in _meta_tables
      const meta = await pool.query(
        `SELECT * FROM "${testSchema}"._meta_tables WHERE table_name = $1`,
        ['products']
      );
      expect(meta.rows.length).toBe(1);
    });

    it('should create table with indexes', async () => {
      await tableService.createTable(testSchema, {
        name: 'orders',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'customer_id', type: 'INT' },
          { name: 'status', type: 'VARCHAR(20)' },
        ],
        indexes: [
          { name: 'idx_orders_customer', columns: ['customer_id'] },
          { name: 'idx_orders_status', columns: ['status'] },
        ],
      });

      // Verify indexes exist
      const indexes = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
        [testSchema, 'orders']
      );
      const indexNames = indexes.rows.map((r: { indexname: string }) => r.indexname);
      expect(indexNames).toContain('idx_orders_customer');
      expect(indexNames).toContain('idx_orders_status');
    });
  });

  describe('getTableMetadata', () => {
    it('should return table metadata', async () => {
      await tableService.createTable(testSchema, {
        name: 'items',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'name', type: 'VARCHAR(100)', nullable: false },
          { name: 'quantity', type: 'INT', defaultValue: '0' },
        ],
      });

      const metadata = await tableService.getTableMetadata(testSchema, 'items');

      expect(metadata).not.toBeNull();
      expect(metadata?.tableName).toBe('items');
      expect(metadata?.columns.length).toBe(3);

      const idCol = metadata?.columns.find(c => c.name === 'id');
      expect(idCol?.isPrimaryKey).toBe(true);

      const nameCol = metadata?.columns.find(c => c.name === 'name');
      expect(nameCol?.nullable).toBe(false);
    });

    it('should return null for non-existent table', async () => {
      const metadata = await tableService.getTableMetadata(testSchema, 'nonexistent');
      expect(metadata).toBeNull();
    });
  });

  describe('listTables', () => {
    it('should list all tables in schema', async () => {
      await tableService.createTable(testSchema, {
        name: 'table_a',
        columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }],
      });
      await tableService.createTable(testSchema, {
        name: 'table_b',
        columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }],
      });

      const tables = await tableService.listTables(testSchema);

      expect(tables.length).toBe(2);
      expect(tables.map(t => t.tableName)).toContain('table_a');
      expect(tables.map(t => t.tableName)).toContain('table_b');
    });

    it('should not include meta tables', async () => {
      await tableService.createTable(testSchema, {
        name: 'regular_table',
        columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }],
      });

      const tables = await tableService.listTables(testSchema);

      // Should not include _meta_tables
      expect(tables.map(t => t.tableName)).not.toContain('_meta_tables');
    });
  });

  describe('addColumn', () => {
    it('should add column to existing table', async () => {
      await tableService.createTable(testSchema, {
        name: 'test_add_col',
        columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }],
      });

      await tableService.addColumn(testSchema, 'test_add_col', {
        name: 'new_column',
        type: 'VARCHAR(50)',
        nullable: true,
      });

      const metadata = await tableService.getTableMetadata(testSchema, 'test_add_col');
      expect(metadata?.columns.map(c => c.name)).toContain('new_column');
    });
  });

  describe('dropColumn', () => {
    it('should drop column from table', async () => {
      await tableService.createTable(testSchema, {
        name: 'test_drop_col',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'to_drop', type: 'VARCHAR(50)' },
        ],
      });

      await tableService.dropColumn(testSchema, 'test_drop_col', 'to_drop');

      const metadata = await tableService.getTableMetadata(testSchema, 'test_drop_col');
      expect(metadata?.columns.map(c => c.name)).not.toContain('to_drop');
    });
  });

  describe('renameColumn', () => {
    it('should rename column', async () => {
      await tableService.createTable(testSchema, {
        name: 'test_rename_col',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'old_name', type: 'VARCHAR(50)' },
        ],
      });

      await tableService.renameColumn(testSchema, 'test_rename_col', 'old_name', 'new_name');

      const metadata = await tableService.getTableMetadata(testSchema, 'test_rename_col');
      expect(metadata?.columns.map(c => c.name)).toContain('new_name');
      expect(metadata?.columns.map(c => c.name)).not.toContain('old_name');
    });
  });

  describe('dropTable', () => {
    it('should drop table and remove from meta', async () => {
      await tableService.createTable(testSchema, {
        name: 'to_delete',
        columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }],
      });

      await tableService.dropTable(testSchema, 'to_delete');

      const metadata = await tableService.getTableMetadata(testSchema, 'to_delete');
      expect(metadata).toBeNull();

      const meta = await pool.query(
        `SELECT * FROM "${testSchema}"._meta_tables WHERE table_name = $1`,
        ['to_delete']
      );
      expect(meta.rows.length).toBe(0);
    });
  });

  describe('getForeignKeys', () => {
    it('should return empty array when no foreign keys', async () => {
      await tableService.createTable(testSchema, {
        name: 'standalone',
        columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }],
      });

      const foreignKeys = await tableService.getForeignKeys(testSchema);
      expect(foreignKeys).toEqual([]);
    });

    it('should return foreign key relationships', async () => {
      // Create parent table
      await tableService.createTable(testSchema, {
        name: 'users',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'name', type: 'VARCHAR(100)' },
        ],
      });

      // Create child table with foreign key using raw SQL (schema prefix needed)
      await pool.query(`
        CREATE TABLE "${testSchema}"."posts" (
          id SERIAL PRIMARY KEY,
          user_id INT REFERENCES "${testSchema}"."users"(id),
          title VARCHAR(255)
        )
      `);
      await pool.query(
        `INSERT INTO "${testSchema}"._meta_tables (table_name) VALUES ($1)`,
        ['posts']
      );

      const foreignKeys = await tableService.getForeignKeys(testSchema);

      expect(foreignKeys.length).toBe(1);
      expect(foreignKeys[0]).toEqual({
        fromTable: 'posts',
        fromColumn: 'user_id',
        toTable: 'users',
        toColumn: 'id',
      });
    });

    it('should return multiple foreign keys', async () => {
      // Create parent tables
      await tableService.createTable(testSchema, {
        name: 'authors',
        columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }],
      });
      await tableService.createTable(testSchema, {
        name: 'categories',
        columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }],
      });

      // Create child table with multiple foreign keys using raw SQL
      await pool.query(`
        CREATE TABLE "${testSchema}"."articles" (
          id SERIAL PRIMARY KEY,
          author_id INT REFERENCES "${testSchema}"."authors"(id),
          category_id INT REFERENCES "${testSchema}"."categories"(id)
        )
      `);
      await pool.query(
        `INSERT INTO "${testSchema}"._meta_tables (table_name) VALUES ($1)`,
        ['articles']
      );

      const foreignKeys = await tableService.getForeignKeys(testSchema);

      expect(foreignKeys.length).toBe(2);
      expect(foreignKeys.map(fk => fk.fromColumn).sort()).toEqual(['author_id', 'category_id']);
    });
  });

  describe('getSchemaRelations', () => {
    it('should return empty tables array for empty schema', async () => {
      const relations = await tableService.getSchemaRelations(testSchema);

      expect(relations.tables).toEqual([]);
      expect(relations.foreignKeys).toEqual([]);
    });

    it('should return tables with columns', async () => {
      await tableService.createTable(testSchema, {
        name: 'products',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'name', type: 'VARCHAR(100)' },
          { name: 'price', type: 'DECIMAL(10,2)' },
        ],
      });

      const relations = await tableService.getSchemaRelations(testSchema);

      expect(relations.tables.length).toBe(1);
      expect(relations.tables[0].name).toBe('products');
      expect(relations.tables[0].columns.length).toBe(3);

      const idCol = relations.tables[0].columns.find(c => c.name === 'id');
      expect(idCol?.isPrimaryKey).toBe(true);

      const nameCol = relations.tables[0].columns.find(c => c.name === 'name');
      expect(nameCol?.isPrimaryKey).toBe(false);
    });

    it('should return tables with foreign key relationships', async () => {
      // Create tables with relationship
      await tableService.createTable(testSchema, {
        name: 'departments',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'name', type: 'VARCHAR(100)' },
        ],
      });

      // Create child table with foreign key using raw SQL
      await pool.query(`
        CREATE TABLE "${testSchema}"."employees" (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100),
          dept_id INT REFERENCES "${testSchema}"."departments"(id)
        )
      `);
      await pool.query(
        `INSERT INTO "${testSchema}"._meta_tables (table_name) VALUES ($1)`,
        ['employees']
      );

      const relations = await tableService.getSchemaRelations(testSchema);

      // Check tables
      expect(relations.tables.length).toBe(2);
      const tableNames = relations.tables.map(t => t.name).sort();
      expect(tableNames).toEqual(['departments', 'employees']);

      // Check foreign keys
      expect(relations.foreignKeys.length).toBe(1);
      expect(relations.foreignKeys[0]).toEqual({
        fromTable: 'employees',
        fromColumn: 'dept_id',
        toTable: 'departments',
        toColumn: 'id',
      });
    });

    it('should not include meta tables', async () => {
      await tableService.createTable(testSchema, {
        name: 'regular_table',
        columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }],
      });

      const relations = await tableService.getSchemaRelations(testSchema);

      const tableNames = relations.tables.map(t => t.name);
      expect(tableNames).not.toContain('_meta_tables');
    });
  });
});
