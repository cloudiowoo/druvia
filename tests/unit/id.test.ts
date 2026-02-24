import { describe, it, expect } from 'vitest';
import {
  generateId,
  generateTenantId,
  generateUserId,
  generateProjectId,
  generateApiKeyId,
} from '../../packages/shared/src/utils/id.js';

describe('ID Generation', () => {
  describe('generateId', () => {
    it('should generate a random ID without prefix', () => {
      const id = generateId();
      expect(id).toBeDefined();
      expect(id.length).toBeGreaterThan(10);
    });

    it('should generate ID with prefix', () => {
      const id = generateId('test');
      expect(id).toMatch(/^test_/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('generateTenantId', () => {
    it('should generate tenant ID with correct prefix', () => {
      const id = generateTenantId();
      expect(id).toMatch(/^tenant_/);
    });
  });

  describe('generateUserId', () => {
    it('should generate user ID with correct prefix', () => {
      const id = generateUserId();
      expect(id).toMatch(/^user_/);
    });
  });

  describe('generateProjectId', () => {
    it('should generate project ID with correct prefix', () => {
      const id = generateProjectId();
      expect(id).toMatch(/^proj_/);
    });
  });

  describe('generateApiKeyId', () => {
    it('should generate API key ID with correct prefix', () => {
      const id = generateApiKeyId();
      expect(id).toMatch(/^key_/);
    });
  });
});
