// Tenant types
export interface Tenant {
  id: number;
  tenantId: string;
  alias: string;
  name: string;
  ownerUid: number;
  plan: 'free' | 'pro' | 'enterprise';
  settings: Record<string, unknown>;
  status: 'active' | 'suspended' | 'deleted';
  description: string | null;
  storageLimit: number;
  projectLimit: number;
  userLimit: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTenantInput {
  alias: string;
  name: string;
  ownerUid: number;
  plan?: 'free' | 'pro' | 'enterprise';
}

export interface UpdateTenantInput {
  name?: string;
  description?: string;
  plan?: 'free' | 'pro' | 'enterprise';
  settings?: Record<string, unknown>;
  status?: 'active' | 'suspended';
  storageLimit?: number;
  projectLimit?: number;
  userLimit?: number;
}

// User types
export type UserRole = 'super_admin' | 'admin';

export interface User {
  id: number;
  userId: string;
  email: string | null;
  username: string | null;
  avatarUrl: string | null;
  status: 'active' | 'suspended' | 'deleted';
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

// Project types
export interface Project {
  id: number;
  projectId: string;
  tenantId: string;
  alias: string;
  name: string;
  schemaName: string | null;
  settings: Record<string, unknown>;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectInput {
  alias: string;
  name: string;
  tenantId: string;
}

export interface UpdateProjectInput {
  name?: string;
  settings?: Record<string, unknown>;
  status?: 'active' | 'suspended';
}

// Schema Registry types
export interface SchemaRegistry {
  id: number;
  schemaName: string;
  tenantId: string;
  projectId: string | null;
  schemaType: 'tenant' | 'project';
  tableCount: number;
  functionCount: number;
  viewCount: number;
  sizeBytes: number;
  status: 'active' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}

// Backup types
export interface Backup {
  id: number;
  backupId: string;
  tenantId: string;
  projectId: string | null;
  schemaName: string;
  storageKey: string;
  sizeBytes: number;
  tablesCount: number;
  tablesList: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  errorMessage: string | null;
  createdBy: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

// File types
export interface FileMetadata {
  id: number;
  fileId: string;
  tenantId: string;
  projectId: string | null;
  bucket: string;
  path: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  storageProvider: 'local' | 'r2' | 's3';
  storageKey: string | null;
  metadata: Record<string, unknown>;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

// Auth Provider types
export interface TenantAuthProvider {
  id: number;
  tenantId: string;
  provider: 'wechat' | 'dingtalk' | 'feishu' | 'oidc';
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// Storage Config types
export interface TenantStorageConfig {
  id: number;
  tenantId: string;
  provider: 'local' | 'r2' | 's3';
  config: Record<string, unknown>;
  maxFileSizeBytes: number;
  allowedMimeTypes: string[];
  createdAt: Date;
  updatedAt: Date;
}
