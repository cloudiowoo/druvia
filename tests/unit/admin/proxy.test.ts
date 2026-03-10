/**
 * Proxy (原 Middleware) 路由逻辑单元测试
 * 测试单租户/多租户模式下的路由重定向
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 模拟路由逻辑（不依赖 Next.js 运行时）
function createProxyLogic(isMultiTenantEnabled: boolean, defaultTenantId: string) {
  return function handleRequest(pathname: string): { redirect?: string; next: boolean } {
    // Skip proxy for static files and API routes
    if (
      pathname.startsWith('/_next') ||
      pathname.startsWith('/api') ||
      pathname.includes('.')
    ) {
      return { next: true };
    }

    // Single-tenant mode redirects
    if (!isMultiTenantEnabled) {
      // Redirect /dashboard to /t/default
      if (pathname === '/dashboard') {
        return { redirect: `/t/${defaultTenantId}`, next: false };
      }

      // Redirect /tenants to default tenant
      if (pathname === '/tenants' || pathname.startsWith('/tenants/')) {
        return { redirect: `/t/${defaultTenantId}`, next: false };
      }
    }

    return { next: true };
  };
}

describe('Proxy Routing Logic', () => {
  describe('Static Files and API Routes', () => {
    const proxy = createProxyLogic(false, 'default');

    it('should skip /_next paths', () => {
      const result = proxy('/_next/static/chunks/main.js');
      expect(result.next).toBe(true);
      expect(result.redirect).toBeUndefined();
    });

    it('should skip /api paths', () => {
      const result = proxy('/api/v1/projects');
      expect(result.next).toBe(true);
      expect(result.redirect).toBeUndefined();
    });

    it('should skip paths with file extensions', () => {
      const result = proxy('/favicon.ico');
      expect(result.next).toBe(true);
      expect(result.redirect).toBeUndefined();
    });

    it('should skip image files', () => {
      const result = proxy('/images/logo.png');
      expect(result.next).toBe(true);
      expect(result.redirect).toBeUndefined();
    });
  });

  describe('Single-Tenant Mode', () => {
    const proxy = createProxyLogic(false, 'default');

    it('should redirect /dashboard to /t/default', () => {
      const result = proxy('/dashboard');
      expect(result.redirect).toBe('/t/default');
      expect(result.next).toBe(false);
    });

    it('should redirect /tenants to /t/default', () => {
      const result = proxy('/tenants');
      expect(result.redirect).toBe('/t/default');
      expect(result.next).toBe(false);
    });

    it('should redirect /tenants/xxx to /t/default', () => {
      const result = proxy('/tenants/some-tenant-id');
      expect(result.redirect).toBe('/t/default');
      expect(result.next).toBe(false);
    });

    it('should redirect /tenants/xxx/settings to /t/default', () => {
      const result = proxy('/tenants/some-tenant-id/settings');
      expect(result.redirect).toBe('/t/default');
      expect(result.next).toBe(false);
    });

    it('should not redirect /t/xxx paths', () => {
      const result = proxy('/t/default/projects');
      expect(result.next).toBe(true);
      expect(result.redirect).toBeUndefined();
    });

    it('should not redirect /login', () => {
      const result = proxy('/login');
      expect(result.next).toBe(true);
      expect(result.redirect).toBeUndefined();
    });
  });

  describe('Single-Tenant Mode with Custom Default Tenant', () => {
    const proxy = createProxyLogic(false, 'my-company');

    it('should redirect /dashboard to /t/my-company', () => {
      const result = proxy('/dashboard');
      expect(result.redirect).toBe('/t/my-company');
    });

    it('should redirect /tenants to /t/my-company', () => {
      const result = proxy('/tenants');
      expect(result.redirect).toBe('/t/my-company');
    });
  });

  describe('Multi-Tenant Mode', () => {
    const proxy = createProxyLogic(true, 'default');

    it('should not redirect /dashboard', () => {
      const result = proxy('/dashboard');
      expect(result.next).toBe(true);
      expect(result.redirect).toBeUndefined();
    });

    it('should not redirect /tenants', () => {
      const result = proxy('/tenants');
      expect(result.next).toBe(true);
      expect(result.redirect).toBeUndefined();
    });

    it('should not redirect /tenants/xxx', () => {
      const result = proxy('/tenants/some-tenant-id');
      expect(result.next).toBe(true);
      expect(result.redirect).toBeUndefined();
    });

    it('should allow access to all tenant paths', () => {
      const result = proxy('/t/tenant-a/projects');
      expect(result.next).toBe(true);
      expect(result.redirect).toBeUndefined();
    });
  });
});
