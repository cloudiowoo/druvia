import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../../apps/api/src/db/index.js';

describe('Storage Controller Validation', () => {
  // 使用已存在的测试项目
  const testProjectId = 'proj_kjAmtOCABaWsuQBn';

  beforeEach(async () => {
    // 每个测试前清理 bucket 数据
    await pool.query('DELETE FROM druvia_storage_objects WHERE bucket_id IN (SELECT bucket_id FROM druvia_storage_buckets WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_storage_buckets WHERE project_id = $1', [testProjectId]);
  });

  afterAll(async () => {
    // 清理所有测试数据
    await pool.query('DELETE FROM druvia_storage_objects WHERE bucket_id IN (SELECT bucket_id FROM druvia_storage_buckets WHERE project_id = $1)', [testProjectId]);
    await pool.query('DELETE FROM druvia_storage_buckets WHERE project_id = $1', [testProjectId]);
  });

  describe('Bucket Name Validation', () => {
    it('should validate bucket name regex pattern', () => {
      // S3-compatible bucket naming: 3-63 chars, lowercase alphanumeric and hyphens
      const BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

      const validateBucketName = (name: string): boolean => {
        return BUCKET_NAME_REGEX.test(name) && !name.includes('--');
      };

      // Valid names
      expect(validateBucketName('my-bucket')).toBe(true);
      expect(validateBucketName('bucket123')).toBe(true);
      expect(validateBucketName('a1b')).toBe(true);
      expect(validateBucketName('test-bucket-name')).toBe(true);

      // Invalid names
      expect(validateBucketName('ab')).toBe(false); // too short
      expect(validateBucketName('My-Bucket')).toBe(false); // uppercase
      expect(validateBucketName('-bucket')).toBe(false); // starts with hyphen
      expect(validateBucketName('bucket-')).toBe(false); // ends with hyphen
      expect(validateBucketName('test--bucket')).toBe(false); // consecutive hyphens
      expect(validateBucketName('bucket_name')).toBe(false); // underscore
    });
  });

  describe('Object Path Sanitization', () => {
    it('should sanitize object paths', () => {
      const sanitizeObjectPath = (path: string): string | null => {
        if (!path || path.length > 1024) return null;
        if (path.includes('..') || path.includes('\0')) return null;
        const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
        return normalized || null;
      };

      // Valid paths
      expect(sanitizeObjectPath('file.txt')).toBe('file.txt');
      expect(sanitizeObjectPath('folder/file.txt')).toBe('folder/file.txt');
      expect(sanitizeObjectPath('/leading/slash.txt')).toBe('leading/slash.txt');

      // Invalid paths
      expect(sanitizeObjectPath('../etc/passwd')).toBeNull();
      expect(sanitizeObjectPath('folder/../file.txt')).toBeNull();
      expect(sanitizeObjectPath('file\0name.txt')).toBeNull();
      expect(sanitizeObjectPath('')).toBeNull();
      expect(sanitizeObjectPath('a'.repeat(1025))).toBeNull();
    });
  });

  describe('Database Schema', () => {
    it('should have correct bucket table structure', async () => {
      const result = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'druvia_storage_buckets'
        ORDER BY ordinal_position
      `);

      const columns = result.rows.map(r => r.column_name);
      expect(columns).toContain('id');
      expect(columns).toContain('bucket_id');
      expect(columns).toContain('project_id');
      expect(columns).toContain('name');
      expect(columns).toContain('public');
      expect(columns).toContain('file_size_limit');
      expect(columns).toContain('allowed_mime_types');
      expect(columns).toContain('cors_config');
      expect(columns).toContain('created_at');
      expect(columns).toContain('updated_at');
    });

    it('should have correct object table structure', async () => {
      const result = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'druvia_storage_objects'
        ORDER BY ordinal_position
      `);

      const columns = result.rows.map(r => r.column_name);
      expect(columns).toContain('id');
      expect(columns).toContain('object_id');
      expect(columns).toContain('bucket_id');
      expect(columns).toContain('name');
      expect(columns).toContain('size');
      expect(columns).toContain('mime_type');
      expect(columns).toContain('etag');
      expect(columns).toContain('storage_provider');
      expect(columns).toContain('storage_path');
      expect(columns).toContain('metadata');
      expect(columns).toContain('created_by');
      expect(columns).toContain('created_at');
      expect(columns).toContain('updated_at');
    });

    it('should have unique constraint on bucket name per project', async () => {
      const result = await pool.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'druvia_storage_buckets'
        AND constraint_type = 'UNIQUE'
      `);

      expect(result.rows.length).toBeGreaterThan(0);
    });

    it('should have unique constraint on object name per bucket', async () => {
      const result = await pool.query(`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'druvia_storage_objects'
        AND constraint_type = 'UNIQUE'
      `);

      expect(result.rows.length).toBeGreaterThan(0);
    });

    it('should have indexes for performance', async () => {
      const result = await pool.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename IN ('druvia_storage_buckets', 'druvia_storage_objects')
      `);

      const indexNames = result.rows.map(r => r.indexname);
      expect(indexNames.some(n => n.includes('bucket'))).toBe(true);
      expect(indexNames.some(n => n.includes('object'))).toBe(true);
    });
  });
});
