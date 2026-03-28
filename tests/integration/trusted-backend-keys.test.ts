import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as apiKeysService from '../../apps/api/src/modules/api-keys/api-keys.service.js';
import * as projectService from '../../apps/api/src/modules/project/project.service.js';
import * as tenantService from '../../apps/api/src/modules/tenant/tenant.service.js';
import * as trustedBackendKeysService from '../../apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.service.js';

describe('TrustedBackendKeysService Integration', () => {
  const suffix = Date.now().toString().slice(-6);
  const testUserKey = `user_trusted_key_test_${suffix}`;
  const tenantAlias = `trustedk${suffix}`;
  const projectAlias = `trustedp${suffix}`;
  let testUserId: number;
  let testTenantId: string;
  let testProjectId: string;

  beforeAll(async () => {
    const userResult = await pool.query(
      `INSERT INTO druvia_users (user_id, email, username, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`
      ,
      [
        testUserKey,
        `trusted-key-test-${suffix}@test.com`,
        `trusted_key_tester_${suffix}`,
      ]
    );
    testUserId = userResult.rows[0].id;

    const tenant = await tenantService.createTenant({
      alias: tenantAlias,
      name: 'Trusted Key Test Tenant',
      ownerUid: testUserId,
    });
    testTenantId = tenant.tenantId;

    const project = await projectService.createProject({
      tenantId: testTenantId,
      alias: projectAlias,
      name: 'Trusted Key Test Project',
    });
    testProjectId = project.projectId;
  });

  afterAll(async () => {
    if (testProjectId) {
      await pool.query('DELETE FROM druvia_trusted_backend_keys WHERE project_id = $1', [testProjectId]);
      await pool.query('DELETE FROM druvia_api_keys WHERE project_id = $1', [testProjectId]);
    }
    if (testTenantId) {
      await pool.query('DELETE FROM druvia_projects WHERE tenant_id = $1', [testTenantId]);
      await pool.query('DELETE FROM druvia_schema_registry WHERE tenant_id = $1', [testTenantId]);
      await pool.query('DELETE FROM druvia_tenants WHERE tenant_id = $1', [testTenantId]);
    }
    await pool.query('DELETE FROM druvia_users WHERE user_id = $1', [testUserKey]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM druvia_trusted_backend_keys WHERE project_id = $1', [testProjectId]);
    await pool.query('DELETE FROM druvia_api_keys WHERE project_id = $1', [testProjectId]);
  });

  it('creates a trusted backend key with a dedicated prefix and metadata', async () => {
    const result = await trustedBackendKeysService.createTrustedBackendKey(testProjectId, {
      name: 'H5 Backend',
      scopes: ['project_session:issue'],
      createdBy: 'user_trusted_key_test',
    });

    expect(result.key).toMatch(/^drutb_[A-Za-z0-9_-]+$/);
    expect(result.trustedBackendKey.keyPrefix).toBe(result.key.substring(0, 16));
    expect(result.trustedBackendKey.name).toBe('H5 Backend');
    expect(result.trustedBackendKey.scopes).toEqual(['project_session:issue']);
    expect(result.trustedBackendKey.createdBy).toBe('user_trusted_key_test');
  });

  it('lists trusted backend keys without exposing the full secret', async () => {
    await trustedBackendKeysService.createTrustedBackendKey(testProjectId, {
      name: 'H5 Backend',
      scopes: ['project_session:issue', 'storage_ticket:issue'],
    });

    const keys = await trustedBackendKeysService.listTrustedBackendKeys(testProjectId);

    expect(keys).toHaveLength(1);
    expect(keys[0].keyPrefix).toMatch(/^drutb_/);
    expect(keys[0]).not.toHaveProperty('key');
    expect(keys[0].scopes).toEqual(['project_session:issue', 'storage_ticket:issue']);
  });

  it('validates a trusted backend key and rejects a normal api key', async () => {
    const createdTrustedKey = await trustedBackendKeysService.createTrustedBackendKey(testProjectId, {
      name: 'Issuer',
      scopes: ['storage_ticket:issue'],
    });
    const createdApiKey = await apiKeysService.createApiKey(testProjectId, 'Anon');

    const trustedResult = await trustedBackendKeysService.validateTrustedBackendKey(
      createdTrustedKey.key,
      { requiredScope: 'storage_ticket:issue' }
    );
    const apiKeyResult = await trustedBackendKeysService.validateTrustedBackendKey(createdApiKey.key);

    expect(trustedResult).toMatchObject({
      valid: true,
      projectId: testProjectId,
      keyPrefix: createdTrustedKey.trustedBackendKey.keyPrefix,
      scopes: ['storage_ticket:issue'],
    });
    expect(apiKeyResult.valid).toBe(false);
  });

  it('updates last_used_at on successful validation', async () => {
    const created = await trustedBackendKeysService.createTrustedBackendKey(testProjectId, {
      name: 'LastUsed',
    });

    const beforeResult = await pool.query(
      'SELECT last_used_at FROM druvia_trusted_backend_keys WHERE key_prefix = $1',
      [created.trustedBackendKey.keyPrefix]
    );
    expect(beforeResult.rows[0].last_used_at).toBeNull();

    await trustedBackendKeysService.validateTrustedBackendKey(created.key);

    const afterResult = await pool.query(
      'SELECT last_used_at FROM druvia_trusted_backend_keys WHERE key_prefix = $1',
      [created.trustedBackendKey.keyPrefix]
    );
    expect(afterResult.rows[0].last_used_at).not.toBeNull();
  });

  it('does not update last_used_at when the required scope or project check fails', async () => {
    const created = await trustedBackendKeysService.createTrustedBackendKey(testProjectId, {
      name: 'Scoped',
      scopes: ['project_session:issue'],
    });

    await expect(
      trustedBackendKeysService.validateTrustedBackendKey(created.key, {
        requiredScope: 'storage_ticket:issue',
      })
    ).resolves.toMatchObject({
      valid: false,
      reason: 'scope_missing',
    });

    let result = await pool.query(
      'SELECT last_used_at FROM druvia_trusted_backend_keys WHERE key_prefix = $1',
      [created.trustedBackendKey.keyPrefix]
    );
    expect(result.rows[0].last_used_at).toBeNull();

    await expect(
      trustedBackendKeysService.validateTrustedBackendKey(created.key, {
        requiredScope: 'project_session:issue',
        requiredProjectId: 'proj_other',
      })
    ).resolves.toMatchObject({
      valid: false,
      reason: 'project_mismatch',
    });

    result = await pool.query(
      'SELECT last_used_at FROM druvia_trusted_backend_keys WHERE key_prefix = $1',
      [created.trustedBackendKey.keyPrefix]
    );
    expect(result.rows[0].last_used_at).toBeNull();
  });

  it('deletes trusted backend keys only within the same project', async () => {
    const created = await trustedBackendKeysService.createTrustedBackendKey(testProjectId, {
      name: 'Delete Me',
    });

    const deletedWrongProject = await trustedBackendKeysService.deleteTrustedBackendKey(
      created.trustedBackendKey.id,
      'wrong_project_id'
    );
    const deleted = await trustedBackendKeysService.deleteTrustedBackendKey(
      created.trustedBackendKey.id,
      testProjectId
    );

    expect(deletedWrongProject).toBe(false);
    expect(deleted).toBe(true);
    expect(await trustedBackendKeysService.listTrustedBackendKeys(testProjectId)).toEqual([]);
  });
});
