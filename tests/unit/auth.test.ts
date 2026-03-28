import { describe, it, expect, vi } from 'vitest';
import {
  authenticate,
  signToken,
  signProjectUserToken,
  isPlatformUser,
  isProjectUser,
} from '../../apps/api/src/middleware/auth.js';
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

  describe('project user auth helpers', () => {
    it('should generate a valid project user JWT token', () => {
      const token = signProjectUserToken({
        sub: 'usr_proj_123',
        projectId: 'proj_123',
        authType: 'project_user',
        role: 'authenticated',
        provider: 'wechat',
      });

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should include project user claims in token', () => {
      const token = signProjectUserToken({
        sub: 'usr_proj_456',
        projectId: 'proj_456',
        authType: 'project_user',
        role: 'authenticated',
        provider: 'wechat',
      });

      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
        sub: string;
        projectId: string;
        authType: string;
        role: string;
        provider: string;
      };

      expect(decoded.sub).toBe('usr_proj_456');
      expect(decoded.projectId).toBe('proj_456');
      expect(decoded.authType).toBe('project_user');
      expect(decoded.role).toBe('authenticated');
      expect(decoded.provider).toBe('wechat');
    });

    it('should discriminate platform user and project user correctly', () => {
      const platformUser = {
        kind: 'platform_user' as const,
        userId: 'user_123',
        uid: 1,
        role: 'admin',
      };
      const projectUser = {
        kind: 'project_user' as const,
        sub: 'usr_proj_123',
        projectId: 'proj_123',
        authType: 'project_user' as const,
        role: 'authenticated' as const,
        provider: 'wechat',
      };

      expect(isPlatformUser(platformUser)).toBe(true);
      expect(isProjectUser(platformUser)).toBe(false);
      expect(isPlatformUser(projectUser)).toBe(false);
      expect(isProjectUser(projectUser)).toBe(true);
    });
  });

  describe('authenticate', () => {
    it('rejects storage ticket style bearer tokens even if they share the JWT secret', async () => {
      const ticketLikeToken = jwt.sign(
        {
          tokenType: 'storage_trusted_ticket',
          purpose: 'upload',
          projectId: 'proj_123',
          projectUserId: 'usr_proj_123',
          bucket: 'team-assets',
          pathPrefix: 'user-avatars/',
          issuedBy: 'drutb_123',
          issuedVia: 'trusted_storage_ticket',
        },
        process.env.JWT_SECRET!
      );

      const request = {
        headers: {
          authorization: `Bearer ${ticketLikeToken}`,
        },
      } as Parameters<typeof authenticate>[0];
      const reply = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as unknown as Parameters<typeof authenticate>[1];

      await authenticate(request, reply);

      expect(reply.status).toHaveBeenCalledWith(401);
      expect(reply.send).toHaveBeenCalledWith({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
      });
    });
  });
});
