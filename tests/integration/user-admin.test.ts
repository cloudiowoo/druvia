import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as userService from '../../apps/api/src/modules/user/user.service.js';

describe('UserService Admin Functions Integration', () => {
  const testEmailSuffix = '@test-admin-user.com';

  beforeAll(async () => {
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', [`%${testEmailSuffix}`]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', [`%${testEmailSuffix}`]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', [`%${testEmailSuffix}`]);
  });

  describe('createUser', () => {
    it('should create a new user with role', async () => {
      const user = await userService.createUser({
        email: `newadmin${testEmailSuffix}`,
        username: 'newadmin',
        password: 'password123',
        role: 'admin',
      });

      expect(user).toBeDefined();
      expect(user.userId).toMatch(/^user_/);
      expect(user.email).toBe(`newadmin${testEmailSuffix}`);
      expect(user.username).toBe('newadmin');
      expect(user.role).toBe('admin');
      expect(user.status).toBe('active');
    });

    it('should create super_admin user', async () => {
      const user = await userService.createUser({
        email: `superadmin${testEmailSuffix}`,
        username: 'superadmin',
        password: 'password123',
        role: 'super_admin',
      });

      expect(user.role).toBe('super_admin');
    });

    it('should throw error for duplicate email', async () => {
      await userService.createUser({
        email: `duplicate${testEmailSuffix}`,
        username: 'user1',
        password: 'password123',
        role: 'admin',
      });

      await expect(
        userService.createUser({
          email: `duplicate${testEmailSuffix}`,
          username: 'user2',
          password: 'password456',
          role: 'admin',
        })
      ).rejects.toThrow();
    });
  });

  describe('updateUserFull', () => {
    it('should update username', async () => {
      const created = await userService.createUser({
        email: `updatename${testEmailSuffix}`,
        username: 'oldname',
        password: 'password123',
        role: 'admin',
      });

      const updated = await userService.updateUserFull(created.userId, {
        username: 'newname',
      });

      expect(updated?.username).toBe('newname');
    });

    it('should update email', async () => {
      const created = await userService.createUser({
        email: `oldemail${testEmailSuffix}`,
        username: 'user',
        password: 'password123',
        role: 'admin',
      });

      const updated = await userService.updateUserFull(created.userId, {
        email: `newemail${testEmailSuffix}`,
      });

      expect(updated?.email).toBe(`newemail${testEmailSuffix}`);
    });

    it('should update role', async () => {
      const created = await userService.createUser({
        email: `updaterole${testEmailSuffix}`,
        username: 'user',
        password: 'password123',
        role: 'admin',
      });

      const updated = await userService.updateUserFull(created.userId, {
        role: 'super_admin',
      });

      expect(updated?.role).toBe('super_admin');
    });

    it('should update multiple fields', async () => {
      const created = await userService.createUser({
        email: `multiupdate${testEmailSuffix}`,
        username: 'olduser',
        password: 'password123',
        role: 'admin',
      });

      const updated = await userService.updateUserFull(created.userId, {
        username: 'newuser',
        role: 'super_admin',
      });

      expect(updated?.username).toBe('newuser');
      expect(updated?.role).toBe('super_admin');
    });

    it('should return null for non-existent user', async () => {
      const updated = await userService.updateUserFull('user_nonexistent', {
        username: 'newname',
      });

      expect(updated).toBeNull();
    });
  });

  describe('resetPassword', () => {
    it('should reset password and return temp password', async () => {
      const created = await userService.createUser({
        email: `resetpass${testEmailSuffix}`,
        username: 'user',
        password: 'oldpassword',
        role: 'admin',
      });

      const tempPassword = await userService.resetPassword(created.userId);

      expect(tempPassword).toBeDefined();
      expect(tempPassword.length).toBe(12);

      // Verify new password works
      const user = await userService.login({
        email: `resetpass${testEmailSuffix}`,
        password: tempPassword,
      });
      expect(user).toBeDefined();
    });

    it('should invalidate old password after reset', async () => {
      const created = await userService.createUser({
        email: `invalidateold${testEmailSuffix}`,
        username: 'user',
        password: 'oldpassword',
        role: 'admin',
      });

      await userService.resetPassword(created.userId);

      // Old password should not work
      const user = await userService.login({
        email: `invalidateold${testEmailSuffix}`,
        password: 'oldpassword',
      });
      expect(user).toBeNull();
    });
  });

  describe('listUsers with role', () => {
    it('should return users with role field', async () => {
      await userService.createUser({
        email: `listuser1${testEmailSuffix}`,
        username: 'user1',
        password: 'password123',
        role: 'admin',
      });

      const { users } = await userService.listUsers(10, 0);

      expect(users.length).toBeGreaterThan(0);
      users.forEach((user) => {
        expect(user.role).toBeDefined();
        expect(['super_admin', 'admin']).toContain(user.role);
      });
    });
  });
});
