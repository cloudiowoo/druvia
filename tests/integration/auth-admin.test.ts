import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as authService from '../../apps/api/src/modules/auth-admin/auth-admin.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';

describe('AuthAdminService Integration', () => {
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;
  let testSchemaName: string;
  // 使用时间戳确保测试隔离
  const testSuffix = Date.now() % 100000;
  const testUserIdStr = `user_test_auth_admin_${testSuffix}`;

  beforeAll(async () => {
    // 创建测试用户
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [testUserIdStr, `auth-admin-test-${testSuffix}@test.com`, `auth_admin_tester_${testSuffix}`]
    );
    testUserId = userResult.rows[0].id;

    // 创建测试租户
    const tenant = await tenantService.createTenant({
      alias: `taa${testSuffix}`,
      name: 'Auth Admin Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    // 创建测试项目
    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: `paa${testSuffix}`,
      name: 'Auth Admin Test Project',
    });
    testProjectId = project.projectId;
    testSchemaName = project.schemaName;

    // 在项目 schema 中创建 users 表（用于测试用户管理功能）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${testSchemaName}.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL,
        username VARCHAR(255),
        avatar_url VARCHAR(1024),
        provider VARCHAR(50) DEFAULT 'email',
        provider_id VARCHAR(255),
        status VARCHAR(20) DEFAULT 'active',
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  });

  afterAll(async () => {
    // 清理项目 schema 中的用户表
    if (testSchemaName) {
      try {
        await pool.query(`DROP TABLE IF EXISTS ${testSchemaName}.users CASCADE`);
      } catch {
        // ignore if schema doesn't exist
      }
    }

    // 清理测试数据（按依赖顺序）
    if (testProjectId) {
      await pool.query('DELETE FROM druvia_project_auth_config WHERE project_id = $1', [testProjectId]);
      await pool.query('DELETE FROM druvia_project_auth_providers WHERE project_id = $1', [testProjectId]);
      await pool.query('DELETE FROM druvia_projects WHERE project_id = $1', [testProjectId]);
    }
    if (testTenantId) {
      await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    }
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', [testUserIdStr]);
  });

  // ============================================
  // Provider CRUD Tests
  // ============================================

  describe('Provider CRUD', () => {
    beforeEach(async () => {
      // 每个测试前清理 provider 数据
      await pool.query('DELETE FROM druvia_project_auth_providers WHERE project_id = $1', [testProjectId]);
    });

    it('should create a provider', async () => {
      const provider = await authService.createProvider(testProjectId, {
        provider: 'google',
        enabled: true,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        config: { redirectUri: 'https://example.com/callback' },
      });

      expect(provider).toBeDefined();
      expect(provider.projectId).toBe(testProjectId);
      expect(provider.provider).toBe('google');
      expect(provider.enabled).toBe(true);
      expect(provider.clientId).toBe('test-client-id');
      // clientSecret 不应该在返回结果中
      expect((provider as Record<string, unknown>).clientSecret).toBeUndefined();
      expect(provider.config).toEqual({ redirectUri: 'https://example.com/callback' });
    });

    it('should list providers', async () => {
      await authService.createProvider(testProjectId, { provider: 'google', clientId: 'g-id' });
      await authService.createProvider(testProjectId, { provider: 'github', clientId: 'gh-id' });

      const providers = await authService.listProviders(testProjectId);

      expect(providers).toHaveLength(2);
      expect(providers.map(p => p.provider).sort()).toEqual(['github', 'google']);
    });

    it('should get provider by name', async () => {
      await authService.createProvider(testProjectId, {
        provider: 'wechat',
        clientId: 'wx-id',
      });

      const provider = await authService.getProvider(testProjectId, 'wechat');

      expect(provider).toBeDefined();
      expect(provider?.provider).toBe('wechat');
      expect(provider?.clientId).toBe('wx-id');
    });

    it('should return null for non-existent provider', async () => {
      const provider = await authService.getProvider(testProjectId, 'nonexistent');
      expect(provider).toBeNull();
    });

    it('should update provider', async () => {
      await authService.createProvider(testProjectId, {
        provider: 'dingtalk',
        enabled: true,
        clientId: 'old-id',
      });

      const updated = await authService.updateProvider(testProjectId, 'dingtalk', {
        enabled: false,
        clientId: 'new-id',
        config: { corpId: 'corp123' },
      });

      expect(updated?.enabled).toBe(false);
      expect(updated?.clientId).toBe('new-id');
      expect(updated?.config).toEqual({ corpId: 'corp123' });
    });

    it('should return null when updating non-existent provider', async () => {
      const updated = await authService.updateProvider(testProjectId, 'nonexistent', {
        enabled: false,
      });
      expect(updated).toBeNull();
    });

    it('should delete provider', async () => {
      await authService.createProvider(testProjectId, { provider: 'feishu', clientId: 'fs-id' });

      const deleted = await authService.deleteProvider(testProjectId, 'feishu');

      expect(deleted).toBe(true);
      const provider = await authService.getProvider(testProjectId, 'feishu');
      expect(provider).toBeNull();
    });

    it('should return false when deleting non-existent provider', async () => {
      const deleted = await authService.deleteProvider(testProjectId, 'nonexistent');
      expect(deleted).toBe(false);
    });

    it('should reject duplicate providers', async () => {
      await authService.createProvider(testProjectId, { provider: 'google' });

      await expect(authService.createProvider(testProjectId, { provider: 'google' }))
        .rejects.toThrow();
    });

    it('should encrypt and retrieve client secret', async () => {
      const secretValue = 'super-secret-value-12345';
      await authService.createProvider(testProjectId, {
        provider: 'microsoft',
        clientId: 'ms-id',
        clientSecret: secretValue,
      });

      // 通过 service 方法获取解密后的 secret
      const retrievedSecret = await authService.getProviderSecret(testProjectId, 'microsoft');

      expect(retrievedSecret).toBe(secretValue);
    });

    it('should return null secret for provider without secret', async () => {
      await authService.createProvider(testProjectId, {
        provider: 'discord',
        clientId: 'dc-id',
        // no clientSecret
      });

      const secret = await authService.getProviderSecret(testProjectId, 'discord');
      expect(secret).toBeNull();
    });

    it('should update client secret', async () => {
      await authService.createProvider(testProjectId, {
        provider: 'github',
        clientId: 'gh-id',
        clientSecret: 'old-secret',
      });

      await authService.updateProvider(testProjectId, 'github', {
        clientSecret: 'new-secret',
      });

      const newSecret = await authService.getProviderSecret(testProjectId, 'github');
      expect(newSecret).toBe('new-secret');
    });
  });

  // ============================================
  // Auth Config Tests
  // ============================================

  describe('Auth Config', () => {
    beforeEach(async () => {
      // 每个测试前清理 config 数据
      await pool.query('DELETE FROM druvia_project_auth_config WHERE project_id = $1', [testProjectId]);
    });

    it('should get default auth config when none exists', async () => {
      const config = await authService.getAuthConfig(testProjectId);

      expect(config).toBeDefined();
      expect(config.projectId).toBe(testProjectId);
      expect(config.jwtExpiresIn).toBe(3600); // default 1 hour
      expect(config.refreshTokenExpiresIn).toBe(604800); // default 7 days
      expect(config.passwordMinLength).toBe(8);
      expect(config.requireEmailVerification).toBe(false);
      expect(config.allowSignup).toBe(true);
    });

    it('should create config on first get', async () => {
      await authService.getAuthConfig(testProjectId);

      // 验证记录已创建
      const result = await pool.query(
        'SELECT * FROM druvia_project_auth_config WHERE project_id = $1',
        [testProjectId]
      );
      expect(result.rows).toHaveLength(1);
    });

    it('should update auth config', async () => {
      // 先获取（会创建默认配置）
      await authService.getAuthConfig(testProjectId);

      const updated = await authService.updateAuthConfig(testProjectId, {
        jwtExpiresIn: 7200,
        passwordMinLength: 12,
        requireEmailVerification: true,
      });

      expect(updated.jwtExpiresIn).toBe(7200);
      expect(updated.passwordMinLength).toBe(12);
      expect(updated.requireEmailVerification).toBe(true);
      // 未更改的字段保持默认值
      expect(updated.refreshTokenExpiresIn).toBe(604800);
    });

    it('should update all config fields', async () => {
      await authService.getAuthConfig(testProjectId);

      const updated = await authService.updateAuthConfig(testProjectId, {
        jwtExpiresIn: 1800,
        refreshTokenExpiresIn: 1209600,
        passwordMinLength: 16,
        requireEmailVerification: true,
        allowSignup: false,
      });

      expect(updated.jwtExpiresIn).toBe(1800);
      expect(updated.refreshTokenExpiresIn).toBe(1209600);
      expect(updated.passwordMinLength).toBe(16);
      expect(updated.requireEmailVerification).toBe(true);
      expect(updated.allowSignup).toBe(false);
    });

    it('should return current config when no updates provided', async () => {
      await authService.updateAuthConfig(testProjectId, { jwtExpiresIn: 9000 });

      const config = await authService.updateAuthConfig(testProjectId, {});

      expect(config.jwtExpiresIn).toBe(9000);
    });
  });

  // ============================================
  // Project Users Tests
  // ============================================

  describe('Project Users', () => {
    beforeEach(async () => {
      // 每个测试前清理用户数据
      await pool.query(`DELETE FROM ${testSchemaName}.users`);
    });

    it('should list project users', async () => {
      // 创建测试用户
      await pool.query(`
        INSERT INTO ${testSchemaName}.users (email, username, provider, status)
        VALUES
          ('user1@test.com', 'user1', 'email', 'active'),
          ('user2@test.com', 'user2', 'google', 'active'),
          ('user3@test.com', 'user3', 'github', 'disabled')
      `);

      const result = await authService.listProjectUsers(testSchemaName);

      expect(result.users).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('should filter users by status', async () => {
      await pool.query(`
        INSERT INTO ${testSchemaName}.users (email, username, status)
        VALUES
          ('active1@test.com', 'active1', 'active'),
          ('active2@test.com', 'active2', 'active'),
          ('disabled1@test.com', 'disabled1', 'disabled')
      `);

      const activeResult = await authService.listProjectUsers(testSchemaName, { status: 'active' });
      const disabledResult = await authService.listProjectUsers(testSchemaName, { status: 'disabled' });

      expect(activeResult.users).toHaveLength(2);
      expect(disabledResult.users).toHaveLength(1);
    });

    it('should search users by email or username', async () => {
      await pool.query(`
        INSERT INTO ${testSchemaName}.users (email, username, status)
        VALUES
          ('alice@example.com', 'alice_wonder', 'active'),
          ('bob@example.com', 'bob_builder', 'active'),
          ('charlie@alice.com', 'charlie', 'active')
      `);

      const result = await authService.listProjectUsers(testSchemaName, { search: 'alice' });

      expect(result.users).toHaveLength(2); // alice@example.com and charlie@alice.com
      expect(result.users.some(u => u.email === 'alice@example.com')).toBe(true);
      expect(result.users.some(u => u.email === 'charlie@alice.com')).toBe(true);
    });

    it('should paginate users', async () => {
      // 创建 5 个用户
      for (let i = 1; i <= 5; i++) {
        await pool.query(`
          INSERT INTO ${testSchemaName}.users (email, username, status)
          VALUES ($1, $2, 'active')
        `, [`user${i}@test.com`, `user${i}`]);
      }

      const page1 = await authService.listProjectUsers(testSchemaName, { limit: 2, offset: 0 });
      const page2 = await authService.listProjectUsers(testSchemaName, { limit: 2, offset: 2 });
      const page3 = await authService.listProjectUsers(testSchemaName, { limit: 2, offset: 4 });

      expect(page1.users).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page2.users).toHaveLength(2);
      expect(page3.users).toHaveLength(1);
    });

    it('should get user by id', async () => {
      const insertResult = await pool.query(`
        INSERT INTO ${testSchemaName}.users (email, username, provider, status)
        VALUES ('getme@test.com', 'getme', 'email', 'active')
        RETURNING id
      `);
      const userId = insertResult.rows[0].id;

      const user = await authService.getProjectUser(testSchemaName, userId);

      expect(user).toBeDefined();
      expect(user?.email).toBe('getme@test.com');
      expect(user?.username).toBe('getme');
      expect(user?.provider).toBe('email');
      expect(user?.status).toBe('active');
    });

    it('should return null for non-existent user', async () => {
      const user = await authService.getProjectUser(testSchemaName, '00000000-0000-0000-0000-000000000000');
      expect(user).toBeNull();
    });

    it('should update user status', async () => {
      const insertResult = await pool.query(`
        INSERT INTO ${testSchemaName}.users (email, username, status)
        VALUES ('disable-me@test.com', 'disable_me', 'active')
        RETURNING id
      `);
      const userId = insertResult.rows[0].id;

      const updated = await authService.updateProjectUser(testSchemaName, userId, {
        status: 'disabled',
      });

      expect(updated?.status).toBe('disabled');
    });

    it('should return user without changes when no status provided', async () => {
      const insertResult = await pool.query(`
        INSERT INTO ${testSchemaName}.users (email, username, status)
        VALUES ('no-change@test.com', 'no_change', 'active')
        RETURNING id
      `);
      const userId = insertResult.rows[0].id;

      const result = await authService.updateProjectUser(testSchemaName, userId, {});

      expect(result?.status).toBe('active');
    });

    it('should delete user', async () => {
      const insertResult = await pool.query(`
        INSERT INTO ${testSchemaName}.users (email, username, status)
        VALUES ('delete-me@test.com', 'delete_me', 'active')
        RETURNING id
      `);
      const userId = insertResult.rows[0].id;

      const deleted = await authService.deleteProjectUser(testSchemaName, userId);

      expect(deleted).toBe(true);
      const user = await authService.getProjectUser(testSchemaName, userId);
      expect(user).toBeNull();
    });

    it('should return false when deleting non-existent user', async () => {
      const deleted = await authService.deleteProjectUser(testSchemaName, '00000000-0000-0000-0000-000000000000');
      expect(deleted).toBe(false);
    });

    it('should return user with all fields correctly mapped', async () => {
      const insertResult = await pool.query(`
        INSERT INTO ${testSchemaName}.users (
          email, username, avatar_url, provider, provider_id, status, last_login_at
        )
        VALUES (
          'full@test.com', 'fulluser', 'https://avatar.com/img.png',
          'google', 'google-123', 'active', '2026-01-01 00:00:00+00'
        )
        RETURNING id
      `);
      const userId = insertResult.rows[0].id;

      const user = await authService.getProjectUser(testSchemaName, userId);

      expect(user).toBeDefined();
      expect(user?.id).toBe(userId);
      expect(user?.email).toBe('full@test.com');
      expect(user?.username).toBe('fulluser');
      expect(user?.avatarUrl).toBe('https://avatar.com/img.png');
      expect(user?.provider).toBe('google');
      expect(user?.providerId).toBe('google-123');
      expect(user?.status).toBe('active');
      expect(user?.lastLoginAt).toBeInstanceOf(Date);
      expect(user?.createdAt).toBeInstanceOf(Date);
    });
  });

  // ============================================
  // Supported Providers Tests
  // ============================================

  describe('Supported Providers', () => {
    it('should return list of supported providers', () => {
      const providers = authService.getSupportedProviders();

      expect(providers).toBeDefined();
      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBeGreaterThan(0);

      // 检查必要的提供商
      const providerIds = providers.map(p => p.id);
      expect(providerIds).toContain('email');
      expect(providerIds).toContain('google');
      expect(providerIds).toContain('github');
      expect(providerIds).toContain('wechat');
      expect(providerIds).toContain('dingtalk');
      expect(providerIds).toContain('feishu');
    });

    it('should have correct provider structure', () => {
      const providers = authService.getSupportedProviders();

      providers.forEach(provider => {
        expect(provider).toHaveProperty('id');
        expect(provider).toHaveProperty('name');
        expect(provider).toHaveProperty('type');
        expect(['builtin', 'oauth']).toContain(provider.type);
      });
    });

    it('should have email as builtin provider', () => {
      const providers = authService.getSupportedProviders();
      const emailProvider = providers.find(p => p.id === 'email');

      expect(emailProvider).toBeDefined();
      expect(emailProvider?.type).toBe('builtin');
    });
  });

  // ============================================
  // Edge Cases and Error Handling
  // ============================================

  describe('Edge Cases', () => {
    beforeEach(async () => {
      await pool.query('DELETE FROM druvia_project_auth_providers WHERE project_id = $1', [testProjectId]);
      await pool.query('DELETE FROM druvia_project_auth_config WHERE project_id = $1', [testProjectId]);
    });

    it('should reject invalid schema names', async () => {
      // SQL 注入尝试
      await expect(authService.listProjectUsers('users; DROP TABLE --'))
        .rejects.toThrow('Invalid schema name');

      await expect(authService.listProjectUsers("'; DELETE FROM users; --"))
        .rejects.toThrow('Invalid schema name');

      // 以数字开头
      await expect(authService.listProjectUsers('123schema'))
        .rejects.toThrow('Invalid schema name');
    });

    it('should handle provider with empty config', async () => {
      const provider = await authService.createProvider(testProjectId, {
        provider: 'google',
        clientId: 'test-id',
        config: {},
      });

      expect(provider.config).toEqual({});
    });

    it('should handle provider with complex config', async () => {
      const complexConfig = {
        redirectUri: 'https://example.com/callback',
        scope: ['profile', 'email', 'openid'],
        customEndpoints: {
          authorize: 'https://custom.auth.com/authorize',
          token: 'https://custom.auth.com/token',
        },
      };

      const provider = await authService.createProvider(testProjectId, {
        provider: 'microsoft',
        clientId: 'ms-id',
        config: complexConfig,
      });

      expect(provider.config).toEqual(complexConfig);
    });

    it('should preserve provider config on partial update', async () => {
      await authService.createProvider(testProjectId, {
        provider: 'github',
        clientId: 'gh-id',
        config: { scope: 'read:user' },
      });

      const updated = await authService.updateProvider(testProjectId, 'github', {
        enabled: false,
      });

      expect(updated?.config).toEqual({ scope: 'read:user' });
    });

    it('should handle concurrent auth config updates', async () => {
      // 先创建配置
      await authService.getAuthConfig(testProjectId);

      // 并发更新
      const updates = await Promise.all([
        authService.updateAuthConfig(testProjectId, { jwtExpiresIn: 1000 }),
        authService.updateAuthConfig(testProjectId, { passwordMinLength: 10 }),
      ]);

      // 两个更新都应该成功（但最终结果取决于执行顺序）
      expect(updates[0]).toBeDefined();
      expect(updates[1]).toBeDefined();

      // 获取最终状态
      const finalConfig = await authService.getAuthConfig(testProjectId);
      // 至少其中一个更新应该生效
      expect(
        finalConfig.jwtExpiresIn === 1000 || finalConfig.passwordMinLength === 10
      ).toBe(true);
    });

    it('should handle empty user list in schema', async () => {
      await pool.query(`DELETE FROM ${testSchemaName}.users`);

      const result = await authService.listProjectUsers(testSchemaName);

      expect(result.users).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });
});
