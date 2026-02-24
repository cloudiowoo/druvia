export interface Tenant {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantConfig {
  tenantId: string;
  features: TenantFeatures;
  limits: TenantLimits;
}

export interface TenantFeatures {
  storage: boolean;
  auth: boolean;
  realtime: boolean;
  functions: boolean;
}

export interface TenantLimits {
  maxStorageBytes: number;
  maxDatabaseRows: number;
  maxApiRequestsPerDay: number;
}
