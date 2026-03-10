// apps/admin/src/proxy.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Read tenant config from environment variables
const isMultiTenantEnabled = process.env.NEXT_PUBLIC_MULTI_TENANT_ENABLED === 'true';
const defaultTenantId = process.env.NEXT_PUBLIC_DEFAULT_TENANT_ID || 'default';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip proxy for static files and API routes
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Single-tenant mode redirects
  if (!isMultiTenantEnabled) {
    // Redirect /dashboard to /t/default/dashboard
    if (pathname === '/dashboard') {
      return NextResponse.redirect(new URL(`/t/${defaultTenantId}`, request.url));
    }

    // Redirect /tenants to default tenant
    if (pathname === '/tenants' || pathname.startsWith('/tenants/')) {
      return NextResponse.redirect(new URL(`/t/${defaultTenantId}`, request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
