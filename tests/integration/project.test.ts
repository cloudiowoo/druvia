import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('ProjectService Integration', () => {
  let testUserId: number;
  let testTenantId: string;

  beforeAll(async () => {
    // 清理可能残留的测试数据
    await pool.query('DELETE FROM druvia_tenants WHERE alias = $1', ['proj_test_tenant']);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_proj_test']);

    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_proj_test', 'proj-test@test.com', 'proj_tester', 'active')
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户 (使用 proj_ 前缀避免与 tenant 测试冲突)
    const tenant = await tenantService.createTenant({
      alias: 'proj_test_tenant',
      name: 'Project Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;
  });

  afterAll(async () => {
    // 清理测试数据 (不关闭 pool，由 vitest 统一处理)
    await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_proj_test']);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
  });

  describe('createProject', () => {
    it('should create a project with schema', async () => {
      const project = await projectService.createProject({
        tenantId: testTenantId,
        alias: 'test_app',
        name: 'Test Application',
      });

      expect(project).toBeDefined();
      expect(project.projectId).toMatch(/^proj_/);
      expect(project.alias).toBe('test_app');
      expect(project.name).toBe('Test Application');
      expect(project.schemaName).toContain('tenant_proj_test_tenant');
      expect(project.status).toBe('active');
    });

    it('should throw error for duplicate alias in same tenant', async () => {
      await projectService.createProject({
        tenantId: testTenantId,
        alias: 'test_dup',
        name: 'First Project',
      });

      await expect(
        projectService.createProject({
          tenantId: testTenantId,
          alias: 'test_dup',
          name: 'Second Project',
        })
      ).rejects.toThrow();
    });
  });

  describe('getProjectById', () => {
    it('should return project by ID', async () => {
      const created = await projectService.createProject({
        tenantId: testTenantId,
        alias: 'test_getbyid',
        name: 'Get By ID Test',
      });

      const project = await projectService.getProjectById(created.projectId);

      expect(project).toBeDefined();
      expect(project?.projectId).toBe(created.projectId);
    });
  });

  describe('listProjects', () => {
    it('should list projects for tenant', async () => {
      await projectService.createProject({
        tenantId: testTenantId,
        alias: 'test_list1',
        name: 'List Test 1',
      });
      await projectService.createProject({
        tenantId: testTenantId,
        alias: 'test_list2',
        name: 'List Test 2',
      });

      const projects = await projectService.listProjects(testTenantId);

      expect(projects.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('updateProject', () => {
    it('should update project name', async () => {
      const created = await projectService.createProject({
        tenantId: testTenantId,
        alias: 'test_update',
        name: 'Original Name',
      });

      const updated = await projectService.updateProject(created.projectId, {
        name: 'Updated Name',
      });

      expect(updated?.name).toBe('Updated Name');
    });
  });

  describe('deleteProject', () => {
    it('should delete project and schema', async () => {
      const created = await projectService.createProject({
        tenantId: testTenantId,
        alias: 'test_delete',
        name: 'Delete Test',
      });

      const deleted = await projectService.deleteProject(created.projectId);
      expect(deleted).toBe(true);

      const project = await projectService.getProjectById(created.projectId);
      expect(project).toBeNull();
    });
  });
});
