import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';
import * as userService from '../../apps/api/src/modules/user/user.service.js';

describe('UserService Integration', () => {
  beforeAll(async () => {
    // 清理测试数据
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', ['%@test-user.com']);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', ['%@test-user.com']);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM druvia_users WHERE email LIKE $1', ['%@test-user.com']);
  });

  describe('register', () => {
    it('should register a new user', async () => {
      const user = await userService.register({
        email: 'newuser@test-user.com',
        password: 'password123',
        username: 'newuser',
      });

      expect(user).toBeDefined();
      expect(user.userId).toMatch(/^user_/);
      expect(user.email).toBe('newuser@test-user.com');
      expect(user.username).toBe('newuser');
      expect(user.status).toBe('active');
    });

    it('should throw error for duplicate email', async () => {
      await userService.register({
        email: 'duplicate@test-user.com',
        password: 'password123',
      });

      await expect(
        userService.register({
          email: 'duplicate@test-user.com',
          password: 'password456',
        })
      ).rejects.toThrow();
    });
  });

  describe('login', () => {
    it('should login with correct credentials', async () => {
      await userService.register({
        email: 'login@test-user.com',
        password: 'correctpassword',
      });

      const user = await userService.login({
        email: 'login@test-user.com',
        password: 'correctpassword',
      });

      expect(user).toBeDefined();
      expect(user?.email).toBe('login@test-user.com');
    });

    it('should return null for wrong password', async () => {
      await userService.register({
        email: 'wrongpass@test-user.com',
        password: 'correctpassword',
      });

      const user = await userService.login({
        email: 'wrongpass@test-user.com',
        password: 'wrongpassword',
      });

      expect(user).toBeNull();
    });

    it('should return null for non-existent user', async () => {
      const user = await userService.login({
        email: 'nonexistent@test-user.com',
        password: 'anypassword',
      });

      expect(user).toBeNull();
    });
  });

  describe('getUserById', () => {
    it('should return user by ID', async () => {
      const created = await userService.register({
        email: 'getbyid@test-user.com',
        password: 'password123',
      });

      const user = await userService.getUserById(created.userId);

      expect(user).toBeDefined();
      expect(user?.userId).toBe(created.userId);
    });
  });

  describe('updateUser', () => {
    it('should update username', async () => {
      const created = await userService.register({
        email: 'update@test-user.com',
        password: 'password123',
        username: 'oldname',
      });

      const updated = await userService.updateUser(created.userId, {
        username: 'newname',
      });

      expect(updated?.username).toBe('newname');
    });
  });

  describe('changePassword', () => {
    it('should change password', async () => {
      const created = await userService.register({
        email: 'changepass@test-user.com',
        password: 'oldpassword',
      });

      const changed = await userService.changePassword(created.userId, 'newpassword');
      expect(changed).toBe(true);

      // Verify new password works
      const user = await userService.login({
        email: 'changepass@test-user.com',
        password: 'newpassword',
      });
      expect(user).toBeDefined();
    });
  });
});
