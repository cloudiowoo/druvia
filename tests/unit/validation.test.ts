import { describe, it, expect } from 'vitest';
import { validateAlias, generateSchemaName } from '../../apps/api/src/lib/validation';

describe('validateAlias', () => {
  it('should accept valid alias', () => {
    expect(() => validateAlias('acme', 'tenant')).not.toThrow();
    expect(() => validateAlias('abc', 'tenant')).not.toThrow();
    expect(() => validateAlias('a1b2c3d4e5f6g7h8', 'tenant')).not.toThrow();
  });

  it('should reject too short alias', () => {
    expect(() => validateAlias('ab', 'tenant')).toThrow('tenant 必须是 3-16 个小写字母或数字');
  });

  it('should reject too long alias', () => {
    expect(() => validateAlias('a1b2c3d4e5f6g7h8i', 'tenant')).toThrow();
  });

  it('should reject uppercase', () => {
    expect(() => validateAlias('Acme', 'tenant')).toThrow();
  });

  it('should reject underscore', () => {
    expect(() => validateAlias('acme_corp', 'tenant')).toThrow();
  });

  it('should reject hyphen', () => {
    expect(() => validateAlias('acme-corp', 'tenant')).toThrow();
  });
});

describe('generateSchemaName', () => {
  it('should generate correct schema name', () => {
    expect(generateSchemaName('acme', 'main')).toBe('dru_acme_main');
    expect(generateSchemaName('corp2024', 'api1')).toBe('dru_corp2024_api1');
  });
});
