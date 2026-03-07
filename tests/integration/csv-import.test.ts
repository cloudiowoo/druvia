import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tableService from '../../apps/api/src/modules/table/table.service.js';
// @ts-expect-error pg-format has no types
import format from '../../apps/api/node_modules/pg-format/lib/index.js';

/**
 * Phase 5 P1 集成测试 - CSV 导入功能
 *
 * 测试 import.routes.ts 中的导入逻辑（通过 service 层）
 */
describe('CSV Import Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;
  let testSchemaName: string;
  const testSuffix = Date.now() % 100000;
  const testUserIdStr = `user_test_csv_import_${testSuffix}`;

  beforeAll(async () => {
    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, password_hash, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [testUserIdStr, `csv-import-test-${testSuffix}@test.com`, `csv_import_tester_${testSuffix}`, '$2b$10$dummyhash']
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: `tci${testSuffix}`,
      name: 'CSV Import Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: `pci${testSuffix}`,
      name: 'CSV Import Test Project',
    });
    testProjectId = project.projectId;
    testSchemaName = project.schemaName;

    // 创建测试表
    await tableService.createTable(testSchemaName, {
      name: 'products',
      columns: [
        { name: 'id', type: 'SERIAL', primaryKey: true },
        { name: 'name', type: 'VARCHAR(255)', nullable: false },
        { name: 'price', type: 'DECIMAL(10,2)', nullable: true },
        { name: 'quantity', type: 'INT', defaultValue: '0' },
      ],
    });
  });

  afterAll(async () => {
    // 清理测试数据
    if (testSchemaName) {
      try {
        await pool.query(`DROP TABLE IF EXISTS "${testSchemaName}"."products" CASCADE`);
      } catch {
        // ignore
      }
    }
    if (testProjectId) {
      await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [testProjectId]);
    }
    if (testTenantId) {
      await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    }
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', [testUserIdStr]);
  });

  beforeEach(async () => {
    // 清空测试表数据
    await pool.query(`DELETE FROM "${testSchemaName}"."products"`);
  });

  // 模拟导入逻辑（与 import.routes.ts 中的逻辑一致）
  async function importRows(
    schemaName: string,
    tableName: string,
    rows: Record<string, unknown>[],
    options: { onError?: 'skip' | 'abort'; batchSize?: number } = {}
  ) {
    const { onError = 'skip', batchSize = 100 } = options;
    const errors: { row: number; error: string }[] = [];
    let imported = 0;
    let skipped = 0;

    if (!rows || rows.length === 0) {
      throw new Error('No rows to import');
    }

    // 验证表存在
    const tableCheck = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, tableName]
    );
    if (tableCheck.rows.length === 0) {
      throw new Error('Table not found');
    }

    // 获取列名
    const columns = Object.keys(rows[0]);

    // 验证列存在
    const columnsResult = await pool.query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [schemaName, tableName]
    );
    const tableColumns = new Set(columnsResult.rows.map((r: { column_name: string }) => r.column_name));
    const invalidColumns = columns.filter(c => !tableColumns.has(c));
    if (invalidColumns.length > 0) {
      throw new Error(`Invalid columns: ${invalidColumns.join(', ')}`);
    }

    // 检查必需列
    const requiredColumns = columnsResult.rows
      .filter((r: { column_name: string; is_nullable: string; column_default: string | null }) =>
        r.is_nullable === 'NO' && r.column_default === null
      )
      .map((r: { column_name: string }) => r.column_name);
    const missingRequired = requiredColumns.filter((c: string) => !columns.includes(c));
    if (missingRequired.length > 0) {
      throw new Error(`Missing required columns: ${missingRequired.join(', ')}`);
    }

    // 批量处理
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const rowIndex = i + j + 1;
        const values = columns.map(col => row[col]);

        try {
          const columnList = columns.map(c => format('%I', c)).join(', ');
          const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
          const sql = format(
            'INSERT INTO %I.%I (%s) VALUES (%s)',
            schemaName,
            tableName,
            columnList,
            placeholders
          );
          await pool.query(sql, values);
          imported++;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          errors.push({ row: rowIndex, error: errorMsg });

          if (onError === 'abort') {
            return {
              success: false,
              imported,
              skipped,
              errors,
              abortedAt: rowIndex,
            };
          }
          skipped++;
        }
      }
    }

    return {
      success: true,
      imported,
      skipped,
      errors: errors.slice(0, 100),
    };
  }

  describe('importRows - 基本功能', () => {
    it('should import valid rows successfully', async () => {
      const rows = [
        { name: 'Product A', price: 10.99, quantity: 100 },
        { name: 'Product B', price: 20.50, quantity: 50 },
        { name: 'Product C', price: 5.00, quantity: 200 },
      ];

      const result = await importRows(testSchemaName, 'products', rows);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      // 验证数据已插入
      const dbResult = await pool.query(`SELECT * FROM "${testSchemaName}"."products"`);
      expect(dbResult.rows).toHaveLength(3);
    });

    it('should skip invalid rows with onError=skip', async () => {
      const rows = [
        { name: 'Valid Product', price: 10.99, quantity: 100 },
        { name: null, price: 20.50, quantity: 50 }, // name is NOT NULL
        { name: 'Another Valid', price: 5.00, quantity: 200 },
      ];

      const result = await importRows(testSchemaName, 'products', rows, { onError: 'skip' });

      expect(result.success).toBe(true);
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].row).toBe(2);
    });

    it('should abort on first error with onError=abort', async () => {
      const rows = [
        { name: 'Valid Product', price: 10.99, quantity: 100 },
        { name: null, price: 20.50, quantity: 50 }, // will fail
        { name: 'Never Inserted', price: 5.00, quantity: 200 },
      ];

      const result = await importRows(testSchemaName, 'products', rows, { onError: 'abort' });

      expect(result.success).toBe(false);
      expect(result.imported).toBe(1);
      expect(result.abortedAt).toBe(2);
    });

    it('should reject empty rows array', async () => {
      await expect(importRows(testSchemaName, 'products', []))
        .rejects.toThrow('No rows');
    });

    it('should reject invalid column names', async () => {
      const rows = [
        { name: 'Product', invalid_column: 'value' },
      ];

      await expect(importRows(testSchemaName, 'products', rows))
        .rejects.toThrow('Invalid columns');
    });

    it('should reject missing required columns', async () => {
      const rows = [
        { price: 10.99, quantity: 100 }, // missing 'name' which is NOT NULL
      ];

      await expect(importRows(testSchemaName, 'products', rows))
        .rejects.toThrow('Missing required columns');
    });

    it('should return error for non-existent table', async () => {
      await expect(importRows(testSchemaName, 'nonexistent', [{ col: 'val' }]))
        .rejects.toThrow('Table not found');
    });
  });

  describe('importRows - 批量处理', () => {
    it('should handle large batch imports', async () => {
      const rows = Array.from({ length: 500 }, (_, i) => ({
        name: `Product ${i}`,
        price: (Math.random() * 100).toFixed(2),
        quantity: Math.floor(Math.random() * 1000),
      }));

      const result = await importRows(testSchemaName, 'products', rows, { batchSize: 50 });

      expect(result.success).toBe(true);
      expect(result.imported).toBe(500);
    });

    it('should process in batches correctly', async () => {
      const rows = Array.from({ length: 25 }, (_, i) => ({
        name: `Batch Product ${i}`,
        price: 10.00,
        quantity: 1,
      }));

      const result = await importRows(testSchemaName, 'products', rows, { batchSize: 10 });

      expect(result.success).toBe(true);
      expect(result.imported).toBe(25);

      const dbResult = await pool.query(`SELECT COUNT(*) as count FROM "${testSchemaName}"."products"`);
      expect(Number(dbResult.rows[0].count)).toBe(25);
    });
  });

  describe('importRows - 数据类型处理', () => {
    it('should handle decimal values correctly', async () => {
      const rows = [
        { name: 'Decimal Test', price: 123.45, quantity: 10 },
      ];

      const result = await importRows(testSchemaName, 'products', rows);
      expect(result.success).toBe(true);

      const dbResult = await pool.query(
        `SELECT price FROM "${testSchemaName}"."products" WHERE name = 'Decimal Test'`
      );
      expect(parseFloat(dbResult.rows[0].price)).toBe(123.45);
    });

    it('should handle null values for nullable columns', async () => {
      const rows = [
        { name: 'Null Price', price: null, quantity: 10 },
      ];

      const result = await importRows(testSchemaName, 'products', rows);
      expect(result.success).toBe(true);

      const dbResult = await pool.query(
        `SELECT price FROM "${testSchemaName}"."products" WHERE name = 'Null Price'`
      );
      expect(dbResult.rows[0].price).toBeNull();
    });

    it('should use default values when column not provided', async () => {
      const rows = [
        { name: 'Default Quantity' }, // quantity has default 0
      ];

      const result = await importRows(testSchemaName, 'products', rows);
      expect(result.success).toBe(true);

      const dbResult = await pool.query(
        `SELECT quantity FROM "${testSchemaName}"."products" WHERE name = 'Default Quantity'`
      );
      expect(dbResult.rows[0].quantity).toBe(0);
    });

    it('should reject invalid data types', async () => {
      const rows = [
        { name: 'Invalid Price', price: 'not-a-number', quantity: 10 },
      ];

      const result = await importRows(testSchemaName, 'products', rows, { onError: 'skip' });
      expect(result.skipped).toBe(1);
      expect(result.errors[0].error).toContain('invalid input syntax');
    });
  });

  describe('importRows - 错误处理', () => {
    it('should collect multiple errors', async () => {
      const rows = [
        { name: 'Valid 1', price: 10.00, quantity: 1 },
        { name: null, price: 20.00, quantity: 2 }, // error
        { name: 'Valid 2', price: 30.00, quantity: 3 },
        { name: null, price: 40.00, quantity: 4 }, // error
        { name: 'Valid 3', price: 50.00, quantity: 5 },
      ];

      const result = await importRows(testSchemaName, 'products', rows, { onError: 'skip' });

      expect(result.success).toBe(true);
      expect(result.imported).toBe(3);
      expect(result.skipped).toBe(2);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].row).toBe(2);
      expect(result.errors[1].row).toBe(4);
    });

    it('should limit error array to 100 entries', async () => {
      // 创建 150 个无效行
      const rows = Array.from({ length: 150 }, () => ({
        name: null, // will fail
        price: 10.00,
      }));

      const result = await importRows(testSchemaName, 'products', rows, { onError: 'skip' });

      expect(result.errors.length).toBeLessThanOrEqual(100);
    });
  });

  describe('importRows - 唯一约束', () => {
    beforeAll(async () => {
      // 添加唯一约束
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_products_name_unique
        ON "${testSchemaName}"."products" (name)
      `);
    });

    afterAll(async () => {
      await pool.query(`
        DROP INDEX IF EXISTS "${testSchemaName}".idx_products_name_unique
      `);
    });

    it('should handle duplicate key violations', async () => {
      // 先插入一条记录
      await pool.query(
        `INSERT INTO "${testSchemaName}"."products" (name, price) VALUES ('Existing', 10.00)`
      );

      const rows = [
        { name: 'Existing', price: 20.00 }, // duplicate
        { name: 'New Product', price: 30.00 },
      ];

      const result = await importRows(testSchemaName, 'products', rows, { onError: 'skip' });

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.errors[0].error).toContain('duplicate key');
    });
  });
});
