import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as functionsService from '../../apps/api/src/modules/functions/functions.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('FunctionsService Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;

  beforeAll(async () => {
    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_test_functions', 'functions-test@test.com', 'functions_tester', 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: 'testfuncs',
      name: 'Functions Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: 'funcproj',
      name: 'Functions Test Project',
    });
    testProjectId = project.projectId;
  });

  afterAll(async () => {
    // 清理测试数据（按依赖顺序）
    await pool.query('DELETE FROM druvia_function_logs WHERE function_id IN (SELECT id FROM druvia_functions WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_function_schedules WHERE function_id IN (SELECT id FROM druvia_functions WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_functions WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_function_secrets WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_test_functions']);
  });

  beforeEach(async () => {
    // 每个测试前清理函数数据
    await pool.query('DELETE FROM druvia_function_logs WHERE function_id IN (SELECT id FROM druvia_functions WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_function_schedules WHERE function_id IN (SELECT id FROM druvia_functions WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_functions WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_function_secrets WHERE project_id = $1', [testProjectId]);
  });

  describe('Functions CRUD', () => {
    it('should create a function', async () => {
      const func = await functionsService.createFunction(testProjectId, {
        name: 'test-func',
        code: 'return { hello: "world" };',
        description: 'Test function',
      });

      expect(func).toBeDefined();
      expect(func.id).toBeDefined();
      expect(func.projectId).toBe(testProjectId);
      expect(func.name).toBe('test-func');
      expect(func.code).toBe('return { hello: "world" };');
      expect(func.runtime).toBe('deno');
      expect(func.status).toBe('active');
      expect(func.description).toBe('Test function');
    });

    it('should list functions', async () => {
      await functionsService.createFunction(testProjectId, { name: 'func-1', code: 'return 1;' });
      await functionsService.createFunction(testProjectId, { name: 'func-2', code: 'return 2;' });

      const functions = await functionsService.listFunctions(testProjectId);

      expect(functions).toHaveLength(2);
      expect(functions.map(f => f.name).sort()).toEqual(['func-1', 'func-2']);
    });

    it('should get function by name', async () => {
      await functionsService.createFunction(testProjectId, { name: 'find-me', code: 'return "found";' });

      const func = await functionsService.getFunction(testProjectId, 'find-me');

      expect(func).toBeDefined();
      expect(func!.name).toBe('find-me');
      expect(func!.code).toBe('return "found";');
    });

    it('should return null for non-existent function', async () => {
      const func = await functionsService.getFunction(testProjectId, 'does-not-exist');
      expect(func).toBeNull();
    });

    it('should update function code', async () => {
      await functionsService.createFunction(testProjectId, { name: 'update-me', code: 'return 1;' });

      const updated = await functionsService.updateFunction(testProjectId, 'update-me', {
        code: 'return 2;',
        description: 'Updated description',
      });

      expect(updated).toBeDefined();
      expect(updated!.code).toBe('return 2;');
      expect(updated!.description).toBe('Updated description');
    });

    it('should update function status', async () => {
      await functionsService.createFunction(testProjectId, { name: 'disable-me', code: 'return 1;' });

      const updated = await functionsService.updateFunction(testProjectId, 'disable-me', {
        status: 'disabled',
      });

      expect(updated).toBeDefined();
      expect(updated!.status).toBe('disabled');
    });

    it('should delete function', async () => {
      await functionsService.createFunction(testProjectId, { name: 'delete-me', code: 'return 1;' });

      const deleted = await functionsService.deleteFunction(testProjectId, 'delete-me');
      expect(deleted).toBe(true);

      const func = await functionsService.getFunction(testProjectId, 'delete-me');
      expect(func).toBeNull();
    });

    it('should return false when deleting non-existent function', async () => {
      const deleted = await functionsService.deleteFunction(testProjectId, 'does-not-exist');
      expect(deleted).toBe(false);
    });

    it('should enforce unique function names per project', async () => {
      await functionsService.createFunction(testProjectId, { name: 'unique-name', code: 'return 1;' });

      await expect(
        functionsService.createFunction(testProjectId, { name: 'unique-name', code: 'return 2;' })
      ).rejects.toThrow();
    });
  });

  describe('Secrets CRUD', () => {
    it('should create a secret', async () => {
      const secret = await functionsService.createSecret(testProjectId, 'MY_API_KEY', 'secret-value-123');

      expect(secret).toBeDefined();
      expect(secret.id).toBeDefined();
      expect(secret.projectId).toBe(testProjectId);
      expect(secret.key).toBe('MY_API_KEY');
      // 注意: value 不应该被返回
      expect((secret as Record<string, unknown>).value).toBeUndefined();
    });

    it('should list secrets (without values)', async () => {
      await functionsService.createSecret(testProjectId, 'KEY_1', 'value1');
      await functionsService.createSecret(testProjectId, 'KEY_2', 'value2');

      const secrets = await functionsService.listSecrets(testProjectId);

      expect(secrets).toHaveLength(2);
      expect(secrets.map(s => s.key).sort()).toEqual(['KEY_1', 'KEY_2']);
      // 确保值没有泄露
      secrets.forEach(s => {
        expect((s as Record<string, unknown>).value).toBeUndefined();
        expect((s as Record<string, unknown>).value_encrypted).toBeUndefined();
      });
    });

    it('should upsert secret (update if exists)', async () => {
      await functionsService.createSecret(testProjectId, 'UPSERT_KEY', 'old-value');
      const updated = await functionsService.createSecret(testProjectId, 'UPSERT_KEY', 'new-value');

      expect(updated.key).toBe('UPSERT_KEY');
      // 只有一个 secret
      const secrets = await functionsService.listSecrets(testProjectId);
      expect(secrets.filter(s => s.key === 'UPSERT_KEY')).toHaveLength(1);
    });

    it('should delete secret', async () => {
      await functionsService.createSecret(testProjectId, 'DELETE_ME', 'value');

      const deleted = await functionsService.deleteSecret(testProjectId, 'DELETE_ME');
      expect(deleted).toBe(true);

      const secrets = await functionsService.listSecrets(testProjectId);
      expect(secrets.find(s => s.key === 'DELETE_ME')).toBeUndefined();
    });

    it('should return false when deleting non-existent secret', async () => {
      const deleted = await functionsService.deleteSecret(testProjectId, 'DOES_NOT_EXIST');
      expect(deleted).toBe(false);
    });
  });

  describe('Schedules CRUD', () => {
    let testFunctionId: string;

    beforeEach(async () => {
      const func = await functionsService.createFunction(testProjectId, {
        name: 'scheduled-func',
        code: 'return { scheduled: true };',
      });
      testFunctionId = func.id;
    });

    it('should create a schedule', async () => {
      const schedule = await functionsService.createSchedule(testFunctionId, '*/5 * * * *');

      expect(schedule).toBeDefined();
      expect(schedule.id).toBeDefined();
      expect(schedule.functionId).toBe(testFunctionId);
      expect(schedule.cronExpression).toBe('*/5 * * * *');
      expect(schedule.enabled).toBe(true);
    });

    it('should list schedules', async () => {
      await functionsService.createSchedule(testFunctionId, '0 * * * *');
      await functionsService.createSchedule(testFunctionId, '0 0 * * *');

      const schedules = await functionsService.listSchedules(testFunctionId);

      expect(schedules).toHaveLength(2);
    });

    it('should update schedule', async () => {
      const schedule = await functionsService.createSchedule(testFunctionId, '*/5 * * * *');

      const updated = await functionsService.updateSchedule(schedule.id, {
        cronExpression: '*/10 * * * *',
        enabled: false,
      });

      expect(updated).toBeDefined();
      expect(updated!.cronExpression).toBe('*/10 * * * *');
      expect(updated!.enabled).toBe(false);
    });

    it('should delete schedule', async () => {
      const schedule = await functionsService.createSchedule(testFunctionId, '*/5 * * * *');

      const deleted = await functionsService.deleteSchedule(schedule.id);
      expect(deleted).toBe(true);

      const schedules = await functionsService.listSchedules(testFunctionId);
      expect(schedules).toHaveLength(0);
    });

    it('should cascade delete schedules when function is deleted', async () => {
      await functionsService.createSchedule(testFunctionId, '*/5 * * * *');
      await functionsService.createSchedule(testFunctionId, '0 * * * *');

      await functionsService.deleteFunction(testProjectId, 'scheduled-func');

      // 验证 schedules 被级联删除
      const result = await pool.query(
        'SELECT COUNT(*) FROM druvia_function_schedules WHERE function_id = $1',
        [testFunctionId]
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });
  });

  describe('Logs', () => {
    let testFunctionId: string;

    beforeEach(async () => {
      const func = await functionsService.createFunction(testProjectId, {
        name: 'logged-func',
        code: 'return { logged: true };',
      });
      testFunctionId = func.id;

      // 手动插入一些测试日志
      await pool.query(
        `INSERT INTO druvia_function_logs (function_id, execution_id, level, message, duration_ms, metadata)
         VALUES ($1, gen_random_uuid(), 'info', 'Test log 1', 100, '{}'),
                ($1, gen_random_uuid(), 'error', 'Test error', 50, '{"error": true}'),
                ($1, gen_random_uuid(), 'info', 'Test log 2', 75, '{}')`,
        [testFunctionId]
      );
    });

    it('should get function logs', async () => {
      const logs = await functionsService.getLogs(testFunctionId);

      expect(logs).toHaveLength(3);
      expect(logs[0].functionId).toBe(testFunctionId);
    });

    it('should filter logs by level', async () => {
      const logs = await functionsService.getLogs(testFunctionId, { level: 'error' });

      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('error');
      expect(logs[0].message).toBe('Test error');
    });

    it('should respect limit and offset', async () => {
      const logs = await functionsService.getLogs(testFunctionId, { limit: 2, offset: 1 });

      expect(logs).toHaveLength(2);
    });

    it('should order logs by created_at DESC', async () => {
      const logs = await functionsService.getLogs(testFunctionId);

      // 最新的日志应该在前面
      for (let i = 1; i < logs.length; i++) {
        expect(new Date(logs[i - 1].createdAt).getTime())
          .toBeGreaterThanOrEqual(new Date(logs[i].createdAt).getTime());
      }
    });

    it('should cascade delete logs when function is deleted', async () => {
      await functionsService.deleteFunction(testProjectId, 'logged-func');

      const result = await pool.query(
        'SELECT COUNT(*) FROM druvia_function_logs WHERE function_id = $1',
        [testFunctionId]
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });
  });

  describe('Function Invocation', () => {
    // 注意: 这些测试需要 Deno Worker 运行在 localhost:7133
    // 如果 Deno Worker 未运行，跳过这些测试

    it('should invoke function and return result', async () => {
      await functionsService.createFunction(testProjectId, {
        name: 'invoke-test',
        code: 'return { result: "success", payload };',
      });

      try {
        const result = await functionsService.invokeFunction(testProjectId, 'invoke-test', { input: 'test' });

        expect(result.success).toBe(true);
        expect(result.executionId).toBeDefined();
        expect(result.duration).toBeGreaterThanOrEqual(0);
        expect(result.data).toEqual({ result: 'success', payload: { input: 'test' } });
      } catch (error) {
        // 如果 Deno Worker 未运行，跳过测试
        if ((error as Error).message.includes('fetch failed') || (error as Error).message.includes('ECONNREFUSED')) {
          console.warn('Skipping invocation test: Deno Worker not running');
          return;
        }
        throw error;
      }
    });

    it('should handle function errors', async () => {
      await functionsService.createFunction(testProjectId, {
        name: 'error-test',
        code: 'throw new Error("intentional error");',
      });

      try {
        const result = await functionsService.invokeFunction(testProjectId, 'error-test');

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error!.message).toContain('intentional error');
      } catch (error) {
        if ((error as Error).message.includes('fetch failed') || (error as Error).message.includes('ECONNREFUSED')) {
          console.warn('Skipping error test: Deno Worker not running');
          return;
        }
        throw error;
      }
    });

    it('should not invoke disabled function', async () => {
      await functionsService.createFunction(testProjectId, {
        name: 'disabled-test',
        code: 'return { ok: true };',
      });
      await functionsService.updateFunction(testProjectId, 'disabled-test', { status: 'disabled' });

      await expect(
        functionsService.invokeFunction(testProjectId, 'disabled-test')
      ).rejects.toThrow('Function is disabled');
    });

    it('should throw for non-existent function', async () => {
      await expect(
        functionsService.invokeFunction(testProjectId, 'does-not-exist')
      ).rejects.toThrow('Function not found');
    });

    it('should create log entry after invocation', async () => {
      const func = await functionsService.createFunction(testProjectId, {
        name: 'log-test',
        code: 'return { logged: true };',
      });

      try {
        await functionsService.invokeFunction(testProjectId, 'log-test');

        const logs = await functionsService.getLogs(func.id);
        expect(logs.length).toBeGreaterThan(0);
        expect(logs[0].functionId).toBe(func.id);
      } catch (error) {
        if ((error as Error).message.includes('fetch failed') || (error as Error).message.includes('ECONNREFUSED')) {
          console.warn('Skipping log test: Deno Worker not running');
          return;
        }
        throw error;
      }
    });

    it('should inject secrets into function environment', async () => {
      await functionsService.createFunction(testProjectId, {
        name: 'secret-test',
        code: 'const key = Deno.env.get("TEST_SECRET"); return { hasSecret: !!key, length: key?.length };',
      });
      await functionsService.createSecret(testProjectId, 'TEST_SECRET', 'my-secret-value');

      try {
        const result = await functionsService.invokeFunction(testProjectId, 'secret-test');

        expect(result.success).toBe(true);
        expect(result.data).toEqual({ hasSecret: true, length: 15 });
      } catch (error) {
        if ((error as Error).message.includes('fetch failed') || (error as Error).message.includes('ECONNREFUSED')) {
          console.warn('Skipping secret test: Deno Worker not running');
          return;
        }
        throw error;
      }
    });
  });
});
