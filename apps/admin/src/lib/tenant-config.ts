// apps/admin/src/lib/tenant-config.ts

export const tenantConfig = {
  multiTenantEnabled: process.env.NEXT_PUBLIC_MULTI_TENANT_ENABLED === 'true',
  defaultTenantId: process.env.NEXT_PUBLIC_DEFAULT_TENANT_ID || 'default',
};

export function isMultiTenantEnabled(): boolean {
  return tenantConfig.multiTenantEnabled;
}

export function getDefaultTenantId(): string {
  return tenantConfig.defaultTenantId;
}
