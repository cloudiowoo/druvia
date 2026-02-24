import { describe, it, expect } from 'vitest';
import { signToken } from '../../apps/api/src/middleware/auth.js';
import jwt from 'jsonwebtoken';

describe('Auth Middleware', () => {
  describe('signToken', () => {
    it('should generate a valid JWT token', () => {
      const payload = { userId: 'user_123', uid: 1 };
      const token = signToken(payload);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');

      // Verify token structure
      const parts = token.split('.');
      expect(parts.length).toBe(3);
    });

    it('should include payload in token', () => {
      const payload = { userId: 'user_456', uid: 2, tenantId: 'tenant_789' };
      const token = signToken(payload);

      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as typeof payload;
      expect(decoded.userId).toBe(payload.userId);
      expect(decoded.uid).toBe(payload.uid);
      expect(decoded.tenantId).toBe(payload.tenantId);
    });

    it('should set expiration time', () => {
      const payload = { userId: 'user_exp', uid: 3 };
      const token = signToken(payload, '1h');

      const decoded = jwt.decode(token) as { exp: number; iat: number };
      expect(decoded.exp).toBeDefined();
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp - decoded.iat).toBe(3600); // 1 hour in seconds
    });
  });
});
