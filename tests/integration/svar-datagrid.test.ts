import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as tableService from '../../apps/api/src/modules/table/table.service.js';
import * as dataService from '../../apps/api/src/modules/data/data.service.js';

/**
 * Phase 1 集成测试 - SVAR DataGrid 数据操作
 *
 * 测试 DruviaDataProvider 适配层依赖的后端 API：
 * - 行数据 CRUD (listRows, insertRow, updateRow, deleteRow, deleteRows)
 * - 分页、排序、筛选功能
 */
describe('SVAR DataGrid Integration - Row CRUD', () => {
  const testSchema = 'test_svar_grid';
  const testTable = 'grid_items';

  beforeAll(async () => {
    // Create test schema
    await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${testSchema}"`);

    // Create _meta_tables
    await pool.query(`
      CREATE TABLE "${testSchema}"._meta_tables (
        id SERIAL PRIMARY KEY,
        table_name VARCHAR(128) UNIQUE NOT NULL,
        description TEXT,
        row_count BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create test table with various column types
    await tableService.createTable(testSchema, {
      name: testTable,
      columns: [
        { name: 'id', type: 'SERIAL', primaryKey: true },
        { name: 'title', type: 'VARCHAR(255)', nullable: false },
        { name: 'description', type: 'TEXT', nullable: true },
        { name: 'price', type: 'INTEGER', defaultValue: '0' },
        { name: 'is_active', type: 'BOOLEAN', defaultValue: 'true' },
        { name: 'created_at', type: 'TIMESTAMPTZ', defaultValue: 'NOW()' },
      ],
    });
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  });

  beforeEach(async () => {
    // Reset test data
    await pool.query(`TRUNCATE "${testSchema}"."${testTable}" RESTART IDENTITY`);
    // Insert test data
    await pool.query(`
      INSERT INTO "${testSchema}"."${testTable}" (title, description, price, is_active)
      VALUES
        ('Item A', 'Description A', 100, true),
        ('Item B', 'Description B', 200, false),
        ('Item C', 'Description C', 150, true),
        ('Item D', NULL, 300, true),
        ('Item E', 'Description E', 50, false)
    `);
  });

  describe('listRows - 分页功能', () => {
    it('should return paginated results with default limit', async () => {
      const result = await dataService.listRows(testSchema, testTable, {});

      expect(result.rows.length).toBe(5);
      expect(result.total).toBe(5);
      expect(result.columns.length).toBeGreaterThan(0);
    });

    it('should respect limit and offset', async () => {
      const result = await dataService.listRows(testSchema, testTable, {
        limit: 2,
        offset: 1,
      });

      expect(result.rows.length).toBe(2);
      expect(result.total).toBe(5);
      expect(result.rows[0].title).toBe('Item B');
    });

    it('should return column metadata', async () => {
      const result = await dataService.listRows(testSchema, testTable, { limit: 1 });

      const columns = result.columns;
      expect(columns.find(c => c.name === 'id')).toBeDefined();
      expect(columns.find(c => c.name === 'title')).toBeDefined();
      expect(columns.find(c => c.name === 'price')).toBeDefined();
    });
  });

  describe('listRows - 排序功能', () => {
    it('should sort by column ascending', async () => {
      const result = await dataService.listRows(testSchema, testTable, {
        orderBy: 'price',
        orderDir: 'asc',
      });

      expect(result.rows[0].price).toBe(50);
      expect(result.rows[4].price).toBe(300);
    });

    it('should sort by column descending', async () => {
      const result = await dataService.listRows(testSchema, testTable, {
        orderBy: 'price',
        orderDir: 'desc',
      });

      expect(result.rows[0].price).toBe(300);
      expect(result.rows[4].price).toBe(50);
    });

    it('should sort by string column', async () => {
      const result = await dataService.listRows(testSchema, testTable, {
        orderBy: 'title',
        orderDir: 'desc',
      });

      expect(result.rows[0].title).toBe('Item E');
    });
  });

  describe('listRows - 筛选功能', () => {
    it('should filter with eq operator', async () => {
      const result = await dataService.listRows(testSchema, testTable, {
        filters: [{ column: 'is_active', operator: 'eq', value: true }],
      });

      expect(result.rows.length).toBe(3);
      expect(result.rows.every(r => r.is_active === true)).toBe(true);
    });

    it('should filter with gt operator', async () => {
      const result = await dataService.listRows(testSchema, testTable, {
        filters: [{ column: 'price', operator: 'gt', value: 150 }],
      });

      expect(result.rows.length).toBe(2);
      expect(result.rows.every(r => Number(r.price) > 150)).toBe(true);
    });

    it('should filter with like operator', async () => {
      const result = await dataService.listRows(testSchema, testTable, {
        filters: [{ column: 'title', operator: 'like', value: '%A%' }],
      });

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].title).toBe('Item A');
    });

    it('should filter with is_null operator', async () => {
      const result = await dataService.listRows(testSchema, testTable, {
        filters: [{ column: 'description', operator: 'is_null' }],
      });

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].title).toBe('Item D');
    });

    it('should combine multiple filters', async () => {
      const result = await dataService.listRows(testSchema, testTable, {
        filters: [
          { column: 'is_active', operator: 'eq', value: true },
          { column: 'price', operator: 'gte', value: 100 },
        ],
      });

      expect(result.rows.length).toBe(3); // Item A (100), Item C (150), Item D (300)
    });
  });

  describe('insertRow - 新增行', () => {
    it('should create a new row', async () => {
      const newRow = await dataService.insertRow(testSchema, testTable, {
        title: 'New Item',
        description: 'New Description',
        price: 999,
      });

      expect(newRow.id).toBeDefined();
      expect(newRow.title).toBe('New Item');
      expect(newRow.price).toBe(999);
    });

    it('should use default values', async () => {
      const newRow = await dataService.insertRow(testSchema, testTable, {
        title: 'Default Test',
      });

      expect(newRow.price).toBe(0);
      expect(newRow.is_active).toBe(true);
      expect(newRow.created_at).toBeDefined();
    });
  });

  describe('updateRow - 更新行', () => {
    it('should update row by primary key', async () => {
      const updated = await dataService.updateRow(
        testSchema,
        testTable,
        { id: 1 },
        { title: 'Updated Title', price: 999 }
      );

      expect(updated.title).toBe('Updated Title');
      expect(updated.price).toBe(999);
    });

    it('should only update specified fields', async () => {
      const original = await pool.query(
        `SELECT * FROM "${testSchema}"."${testTable}" WHERE id = 1`
      );
      const originalDesc = original.rows[0].description;

      await dataService.updateRow(
        testSchema,
        testTable,
        { id: 1 },
        { title: 'Only Title Changed' }
      );

      const result = await pool.query(
        `SELECT * FROM "${testSchema}"."${testTable}" WHERE id = 1`
      );
      expect(result.rows[0].title).toBe('Only Title Changed');
      expect(result.rows[0].description).toBe(originalDesc);
    });
  });

  describe('deleteRow - 删除单行', () => {
    it('should delete row by primary key', async () => {
      await dataService.deleteRow(testSchema, testTable, { id: 1 });

      const result = await pool.query(
        `SELECT * FROM "${testSchema}"."${testTable}" WHERE id = 1`
      );
      expect(result.rows.length).toBe(0);
    });
  });

  describe('deleteRows - 批量删除', () => {
    it('should delete multiple rows', async () => {
      const deleted = await dataService.deleteRows(testSchema, testTable, [
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ]);

      expect(deleted).toBe(3);

      const result = await dataService.listRows(testSchema, testTable, {});
      expect(result.total).toBe(2);
    });

    it('should return count of deleted rows', async () => {
      const deleted = await dataService.deleteRows(testSchema, testTable, [
        { id: 1 },
        { id: 999 }, // Non-existent
      ]);

      expect(deleted).toBe(1);
    });
  });
});
