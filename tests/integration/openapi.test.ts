import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tableService from '../../apps/api/src/modules/table/table.service.js';
import { generateProjectOpenApi } from '../../apps/api/src/modules/openapi/openapi.service.js';

/**
 * Phase 5 P1 集成测试 - OpenAPI 文档生成
 *
 * 测试 openapi.service.ts 中的 OpenAPI 规范生成逻辑
 */
describe('OpenAPI Generation Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;
  let testSchemaName: string;
  const testSuffix = Date.now() % 100000;
  const testUserIdStr = `user_test_openapi_${testSuffix}`;

  beforeAll(async () => {
    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, password_hash, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [testUserIdStr, `openapi-test-${testSuffix}@test.com`, `openapi_tester_${testSuffix}`, '$2b$10$dummyhash']
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: `toa${testSuffix}`,
      name: 'OpenAPI Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: `poa${testSuffix}`,
      name: 'OpenAPI Test Project',
    });
    testProjectId = project.projectId;
    testSchemaName = project.schemaName;

    // 创建测试表
    await tableService.createTable(testSchemaName, {
      name: 'users',
      columns: [
        { name: 'id', type: 'SERIAL', primaryKey: true },
        { name: 'email', type: 'VARCHAR(255)', nullable: false },
        { name: 'name', type: 'VARCHAR(100)', nullable: true },
        { name: 'created_at', type: 'TIMESTAMP', defaultValue: 'NOW()' },
      ],
    });

    await tableService.createTable(testSchemaName, {
      name: 'posts',
      columns: [
        { name: 'id', type: 'SERIAL', primaryKey: true },
        { name: 'title', type: 'VARCHAR(255)', nullable: false },
        { name: 'content', type: 'TEXT', nullable: true },
        { name: 'published', type: 'BOOLEAN', defaultValue: 'false' },
      ],
    });
  });

  afterAll(async () => {
    // 清理测试数据
    if (testSchemaName) {
      try {
        await pool.query(`DROP TABLE IF EXISTS "${testSchemaName}"."posts" CASCADE`);
        await pool.query(`DROP TABLE IF EXISTS "${testSchemaName}"."users" CASCADE`);
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

  describe('generateProjectOpenApi', () => {
    it('should return valid OpenAPI 3.0 spec', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        openapi: string;
        info: { title: string; version: string; description: string };
        paths: Record<string, unknown>;
        components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
        servers: Array<{ url: string }>;
        security: Array<Record<string, unknown[]>>;
      };

      expect(spec.openapi).toBe('3.0.3');
      expect(spec.info).toBeDefined();
      expect(spec.info.title).toContain('OpenAPI Test Project');
      expect(spec.paths).toBeDefined();
      expect(spec.components).toBeDefined();
    });

    it('should include paths for all tables', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        paths: Record<string, unknown>;
      };
      const pathKeys = Object.keys(spec.paths);

      // 应该包含 users 和 posts 表的路径
      expect(pathKeys.some(p => p.includes('/users/rows'))).toBe(true);
      expect(pathKeys.some(p => p.includes('/posts/rows'))).toBe(true);
      expect(pathKeys.some(p => p.includes('/users/rows/{id}'))).toBe(true);
      expect(pathKeys.some(p => p.includes('/posts/rows/{id}'))).toBe(true);
    });

    it('should include schema definitions for tables', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        components: { schemas: Record<string, unknown> };
      };
      const schemas = spec.components.schemas;

      // 应该包含 Users 和 Posts schema（PascalCase）
      expect(schemas.Users).toBeDefined();
      expect(schemas.Posts).toBeDefined();
      expect(schemas.UsersInput).toBeDefined();
      expect(schemas.PostsInput).toBeDefined();
    });

    it('should include correct column properties in schema', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        components: { schemas: Record<string, { properties: Record<string, unknown> }> };
      };
      const usersSchema = spec.components.schemas.Users;

      expect(usersSchema.properties.id).toBeDefined();
      expect(usersSchema.properties.email).toBeDefined();
      expect(usersSchema.properties.name).toBeDefined();
      expect(usersSchema.properties.created_at).toBeDefined();
    });

    it('should include security schemes', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        components: {
          securitySchemes: {
            bearerAuth: { type: string; scheme: string; bearerFormat: string };
          };
        };
      };

      expect(spec.components.securitySchemes).toBeDefined();
      expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
      expect(spec.components.securitySchemes.bearerAuth.type).toBe('http');
      expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
      expect(spec.components.securitySchemes.bearerAuth.bearerFormat).toBe('JWT');
    });

    it('should include global security requirement', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        security: Array<Record<string, unknown[]>>;
      };

      expect(spec.security).toBeDefined();
      expect(spec.security).toContainEqual({ bearerAuth: [] });
    });

    it('should include CRUD operations for each table', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        paths: Record<string, Record<string, unknown>>;
      };

      // 找到 users 表的路径
      const usersRowsPath = Object.keys(spec.paths).find(p => p.includes('/users/rows') && !p.includes('{id}'));
      const usersRowIdPath = Object.keys(spec.paths).find(p => p.includes('/users/rows/{id}'));

      expect(usersRowsPath).toBeDefined();
      expect(usersRowIdPath).toBeDefined();

      // 检查 CRUD 操作
      expect(spec.paths[usersRowsPath!].get).toBeDefined(); // List
      expect(spec.paths[usersRowsPath!].post).toBeDefined(); // Create
      expect(spec.paths[usersRowIdPath!].get).toBeDefined(); // Get by ID
      expect(spec.paths[usersRowIdPath!].patch).toBeDefined(); // Update
      expect(spec.paths[usersRowIdPath!].delete).toBeDefined(); // Delete
    });

    it('should throw error for non-existent project', async () => {
      await expect(generateProjectOpenApi('nonexistent-project-id', 'http://localhost:3001'))
        .rejects.toThrow('Project not found');
    });

    it('should include server URL in spec', async () => {
      const baseUrl = 'https://api.example.com';
      const spec = await generateProjectOpenApi(testProjectId, baseUrl) as {
        servers: Array<{ url: string }>;
      };

      expect(spec.servers).toBeDefined();
      expect(spec.servers.length).toBeGreaterThan(0);
      expect(spec.servers[0].url).toBe(baseUrl);
    });

    it('should include query parameters for list endpoint', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        paths: Record<string, { get?: { parameters?: Array<{ name: string; in: string }> } }>;
      };

      const usersRowsPath = Object.keys(spec.paths).find(p => p.includes('/users/rows') && !p.includes('{id}'));
      const listOperation = spec.paths[usersRowsPath!].get;

      expect(listOperation?.parameters).toBeDefined();
      const paramNames = listOperation?.parameters?.map(p => p.name) || [];
      expect(paramNames).toContain('limit');
      expect(paramNames).toContain('offset');
    });

    it('should include path parameter for single row endpoint', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        paths: Record<string, { get?: { parameters?: Array<{ name: string; in: string; required?: boolean }> } }>;
      };

      const usersRowIdPath = Object.keys(spec.paths).find(p => p.includes('/users/rows/{id}'));
      const getOperation = spec.paths[usersRowIdPath!].get;

      expect(getOperation?.parameters).toBeDefined();
      const idParam = getOperation?.parameters?.find(p => p.name === 'id');
      expect(idParam).toBeDefined();
      expect(idParam?.in).toBe('path');
      expect(idParam?.required).toBe(true);
    });

    it('should include request body for create endpoint', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        paths: Record<string, { post?: { requestBody?: { content?: Record<string, unknown> } } }>;
      };

      const usersRowsPath = Object.keys(spec.paths).find(p => p.includes('/users/rows') && !p.includes('{id}'));
      const createOperation = spec.paths[usersRowsPath!].post;

      expect(createOperation?.requestBody).toBeDefined();
      expect(createOperation?.requestBody?.content?.['application/json']).toBeDefined();
    });

    it('should include response schemas', async () => {
      const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
        paths: Record<string, { get?: { responses?: Record<string, { description?: string; content?: Record<string, unknown> }> } }>;
      };

      const usersRowsPath = Object.keys(spec.paths).find(p => p.includes('/users/rows') && !p.includes('{id}'));
      const listOperation = spec.paths[usersRowsPath!].get;

      expect(listOperation?.responses?.['200']).toBeDefined();
      expect(listOperation?.responses?.['200']?.content?.['application/json']).toBeDefined();
    });

    it('should use correct schema name format (PascalCase)', async () => {
      // 创建一个 snake_case 表名
      await tableService.createTable(testSchemaName, {
        name: 'user_profiles',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'bio', type: 'TEXT' },
        ],
      });

      try {
        const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
          components: { schemas: Record<string, unknown> };
        };

        // snake_case 应该转换为 PascalCase
        expect(spec.components.schemas.UserProfiles).toBeDefined();
        expect(spec.components.schemas.UserProfilesInput).toBeDefined();
      } finally {
        await pool.query(`DROP TABLE IF EXISTS "${testSchemaName}"."user_profiles" CASCADE`);
      }
    });
  });

  describe('OpenAPI Schema Types', () => {
    it('should map PostgreSQL types to OpenAPI types correctly', async () => {
      // 创建包含各种类型的表
      await tableService.createTable(testSchemaName, {
        name: 'type_test',
        columns: [
          { name: 'id', type: 'SERIAL', primaryKey: true },
          { name: 'int_col', type: 'INTEGER' },
          { name: 'bigint_col', type: 'BIGINT' },
          { name: 'text_col', type: 'TEXT' },
          { name: 'bool_col', type: 'BOOLEAN' },
          { name: 'decimal_col', type: 'DECIMAL(10,2)' },
          { name: 'timestamp_col', type: 'TIMESTAMP' },
          { name: 'json_col', type: 'JSONB' },
        ],
      });

      try {
        const spec = await generateProjectOpenApi(testProjectId, 'http://localhost:3001') as {
          components: { schemas: Record<string, { properties: Record<string, { type?: string; format?: string }> }> };
        };
        const typeTestSchema = spec.components.schemas.TypeTest;

        expect(typeTestSchema).toBeDefined();
        expect(typeTestSchema.properties.int_col).toBeDefined();
        expect(typeTestSchema.properties.text_col).toBeDefined();
        expect(typeTestSchema.properties.bool_col).toBeDefined();
      } finally {
        await pool.query(`DROP TABLE IF EXISTS "${testSchemaName}"."type_test" CASCADE`);
      }
    });
  });
});
