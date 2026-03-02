/**
 * 方案 A 集成测试：项目数据库凭证管理
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { pool } from '../../apps/api/src/db/index.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as dbCredentialsService from '../../apps/api/src/modules/project/db-credentials.service.js';

let testUserId: number;
let testTenantId: string;
let testProjectId: string;
let testSchemaName: string;

let dbCredentials: {
  username: string;
  password: string;
  host: string;
  port: number;
  database: string;
  schemaName: string;
} | null = null;

describe('项目数据库凭证管理 (方案 A)', () => {
  beforeAll(async () => {
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ('user_db_cred_test', 'db-cred-test@test.com', 'db_cred_tester', 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    const tenant = await tenantService.createTenant({
      alias: `tdb${Date.now() % 100000}`,
      name: '数据库凭证测试租户',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: `pdb${Date.now() % 100000}`,
      name: '数据库凭证测试项目',
    });
    testProjectId = project.projectId;
    testSchemaName = project.schemaName!;
  });

  afterAll(async () => {
    if (testProjectId) {
      try {
        await dbCredentialsService.dropProjectDbUser(testProjectId);
      } catch { /* ignore */ }
      try {
        await projectService.deleteProject(testProjectId);
      } catch { /* ignore */ }
    }
    if (testTenantId) {
      try {
        await tenantService.deleteTenant(testTenantId);
      } catch { /* ignore */ }
    }
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_db_cred_test']);
  });

  it('1. 初始状态无凭证', async () => {
    const info = await dbCredentialsService.getProjectDbInfo(testProjectId);
    expect(info).not.toBeNull();
    expect(info!.hasCredentials).toBe(false);
    expect(info!.schemaName).toBe(testSchemaName);
  });

  it('2. 创建数据库用户', async () => {
    const credentials = await dbCredentialsService.createProjectDbUser(testProjectId, testSchemaName);
    expect(credentials.username).toMatch(/^dru_.*_user$/);
    expect(credentials.password).toHaveLength(24);
    dbCredentials = credentials;

    const info = await dbCredentialsService.getProjectDbInfo(testProjectId);
    expect(info!.hasCredentials).toBe(true);
  });

  it('3. 使用凭证连接数据库', async () => {
    const client = new Client({
      host: dbCredentials!.host,
      port: dbCredentials!.port,
      database: dbCredentials!.database,
      user: dbCredentials!.username,
      password: dbCredentials!.password,
    });

    try {
      await client.connect();
      const pathResult = await client.query('SHOW search_path');
      expect(pathResult.rows[0].search_path).toContain(dbCredentials!.schemaName);
    } finally {
      await client.end();
    }
  });

  it('4. 直连执行 DDL 创建表', async () => {
    const client = new Client({
      host: dbCredentials!.host,
      port: dbCredentials!.port,
      database: dbCredentials!.database,
      user: dbCredentials!.username,
      password: dbCredentials!.password,
    });

    try {
      await client.connect();

      // 创建表
      await client.query(`
        CREATE TABLE IF NOT EXISTS test_items (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100)
        )
      `);

      // 插入数据
      await client.query(`INSERT INTO test_items (name) VALUES ('测试项')`);

      // 查询验证
      const result = await client.query('SELECT * FROM test_items');
      expect(result.rows.length).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });

  it('5. 无法访问系统表', async () => {
    const client = new Client({
      host: dbCredentials!.host,
      port: dbCredentials!.port,
      database: dbCredentials!.database,
      user: dbCredentials!.username,
      password: dbCredentials!.password,
    });

    try {
      await client.connect();

      await expect(
        client.query('SELECT * FROM public.druvia_tenants LIMIT 1')
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.end();
    }
  });

  it('6. 重置密码', async () => {
    const oldPassword = dbCredentials!.password;
    const newCreds = await dbCredentialsService.resetProjectDbPassword(testProjectId);

    expect(newCreds).not.toBeNull();
    expect(newCreds!.password).not.toBe(oldPassword);

    // 旧密码失效
    const oldClient = new Client({
      host: dbCredentials!.host,
      port: dbCredentials!.port,
      database: dbCredentials!.database,
      user: dbCredentials!.username,
      password: oldPassword,
    });
    await expect(oldClient.connect()).rejects.toThrow(/password authentication failed/i);

    // 新密码有效
    const newClient = new Client({
      host: newCreds!.host,
      port: newCreds!.port,
      database: newCreds!.database,
      user: newCreds!.username,
      password: newCreds!.password,
    });
    await newClient.connect();
    await newClient.end();

    dbCredentials = newCreds;
  });

  it('7. 删除数据库用户', async () => {
    const result = await dbCredentialsService.dropProjectDbUser(testProjectId);
    expect(result).toBe(true);

    const info = await dbCredentialsService.getProjectDbInfo(testProjectId);
    expect(info!.hasCredentials).toBe(false);

    // 凭证失效
    const client = new Client({
      host: dbCredentials!.host,
      port: dbCredentials!.port,
      database: dbCredentials!.database,
      user: dbCredentials!.username,
      password: dbCredentials!.password,
    });
    await expect(client.connect()).rejects.toThrow(/does not exist|password authentication failed/i);

    dbCredentials = null;
  });
});
