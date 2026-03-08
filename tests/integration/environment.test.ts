import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as environmentService from '../../apps/api/src/modules/environment/environment.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';
import * as tableService from '../../apps/api/src/modules/table/table.service.js';

describe('EnvironmentService Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;
  let testSchemaName: string;

  beforeAll(async () => {
    // 清理可能残留的测试数据
    await pool.query('DELETE FROM druvia_project_environments WHERE project_id IN (SELECT project_id FROM druvia_projects WHERE tenant_id IN (SELECT tenant_id FROM druvia_tenants WHERE alias = $1))', ['envtenant']);
    await pool.query('DELETE FROM druvia_projects WHERE tenant_id IN (SELECT tenant_id FROM druvia_tenants WHERE alias = $1)', ['envtenant']);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id IN (SELECT tenant_id FROM druvia_tenants WHERE alias = $1)', ['envtenant']);
    await pool.query('DELETE FROM druvia_tenants WHERE alias = $1', ['envtenant']);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_env_test']);

    // 清理可能残留的 schema
    const schemasResult = await pool.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'dru_envtenant_%'`
    );
    for (const row of schemasResult.rows) {
      await pool.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
    }

    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_env_test', 'env-test@test.com', 'env_tester', 'active')
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: 'envtenant',
      name: 'Environment Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'envproj',
      name: 'Environment Test Project',
    });
    testProjectId = project.projectId;
    testSchemaName = project.schemaName;

    // 创建测试表
    await tableService.createTable(testSchemaName, {
      name: 'users',
      columns: [
        { name: 'id', type: 'serial', primaryKey: true },
        { name: 'name', type: 'varchar(100)', nullable: false },
        { name: 'email', type: 'varchar(255)', nullable: true },
      ],
    });
  });

  afterAll(async () => {
    // 清理所有环境 schema
    const envs = await environmentService.listEnvironments(testProjectId);
    for (const env of envs) {
      if (env.envName !== 'prod') {
        try {
          await environmentService.deleteEnvironment(testProjectId, env.envName);
        } catch {
          // 忽略清理错误
        }
      }
    }

    await pool.query('DELETE FROM druvia_project_environments WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_env_test']);
  });

  beforeEach(async () => {
    // 清理非 prod 环境
    const envs = await environmentService.listEnvironments(testProjectId);
    for (const env of envs) {
      if (env.envName !== 'prod') {
        try {
          await environmentService.deleteEnvironment(testProjectId, env.envName);
        } catch {
          // 忽略
        }
      }
    }
  });

  describe('resolveSchemaName', () => {
    it('should return base schema for prod', () => {
      expect(environmentService.resolveSchemaName('dru_test', 'prod')).toBe('dru_test');
      expect(environmentService.resolveSchemaName('dru_test', undefined)).toBe('dru_test');
    });

    it('should append env suffix for non-prod', () => {
      expect(environmentService.resolveSchemaName('dru_test', 'dev')).toBe('dru_test_dev');
      expect(environmentService.resolveSchemaName('dru_test', 'staging')).toBe('dru_test_staging');
    });
  });

  describe('createEnvironment', () => {
    it('should create a new environment with cloned schema', async () => {
      const env = await environmentService.createEnvironment(testProjectId, 'dev', false);

      expect(env).toBeDefined();
      expect(env.envName).toBe('dev');
      expect(env.schemaName).toBe(`${testSchemaName}_dev`);
      expect(env.projectId).toBe(testProjectId);

      // 验证 schema 已创建
      const schemaResult = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [env.schemaName]
      );
      expect(schemaResult.rows.length).toBe(1);

      // 验证表已克隆
      const tableResult = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'users'`,
        [env.schemaName]
      );
      expect(tableResult.rows.length).toBe(1);
    });

    it('should clone data when cloneData is true', async () => {
      // 先插入测试数据到 prod
      await pool.query(
        `INSERT INTO "${testSchemaName}".users (name, email) VALUES ($1, $2)`,
        ['Test User', 'test@example.com']
      );

      const env = await environmentService.createEnvironment(testProjectId, 'staging', true);

      // 验证数据已克隆
      const dataResult = await pool.query(
        `SELECT * FROM "${env.schemaName}".users WHERE name = $1`,
        ['Test User']
      );
      expect(dataResult.rows.length).toBe(1);
      expect(dataResult.rows[0].email).toBe('test@example.com');
    });

    it('should throw error for non-existent project', async () => {
      await expect(
        environmentService.createEnvironment('non_existent_project', 'dev', false)
      ).rejects.toThrow('Project not found');
    });
  });

  describe('listEnvironments', () => {
    it('should list all environments for a project', async () => {
      await environmentService.createEnvironment(testProjectId, 'dev', false);
      await environmentService.createEnvironment(testProjectId, 'test', false);

      const envs = await environmentService.listEnvironments(testProjectId);

      // 应该有 dev 和 test（prod 可能不在 druvia_project_environments 表中）
      expect(envs.length).toBeGreaterThanOrEqual(2);
      expect(envs.map(e => e.envName)).toContain('dev');
      expect(envs.map(e => e.envName)).toContain('test');
    });

    it('should return empty array for project without environments', async () => {
      // 创建一个新项目
      const project = await projectService.createProject({
        tenantId: testTenantId,
        alias: 'noenvproj',
        name: 'No Env Project',
      });

      const envs = await environmentService.listEnvironments(project.projectId);

      expect(envs).toEqual([]);

      // 清理
      await projectService.deleteProject(project.projectId);
    });
  });

  describe('deleteEnvironment', () => {
    it('should delete environment and drop schema', async () => {
      const env = await environmentService.createEnvironment(testProjectId, 'todelete', false);

      const deleted = await environmentService.deleteEnvironment(testProjectId, 'todelete');

      expect(deleted).toBe(true);

      // 验证 schema 已删除
      const schemaResult = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [env.schemaName]
      );
      expect(schemaResult.rows.length).toBe(0);

      // 验证记录已删除
      const envResult = await pool.query(
        `SELECT * FROM druvia_project_environments WHERE project_id = $1 AND env_name = $2`,
        [testProjectId, 'todelete']
      );
      expect(envResult.rows.length).toBe(0);
    });

    it('should throw error when deleting prod environment', async () => {
      await expect(
        environmentService.deleteEnvironment(testProjectId, 'prod')
      ).rejects.toThrow('Cannot delete production environment');
    });

    it('should return false for non-existent environment', async () => {
      const deleted = await environmentService.deleteEnvironment(testProjectId, 'nonexistent');

      expect(deleted).toBe(false);
    });
  });
});
