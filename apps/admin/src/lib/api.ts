// Use relative path (empty string) for same-origin requests in production
// Falls back to localhost:3001 for local development without Docker
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// Functions Types
interface EdgeFunction {
  id: string;
  projectId: string;
  name: string;
  code: string;
  runtime: string;
  status: 'active' | 'disabled';
  invokeAuthMode: 'jwt_required' | 'anon_allowed';
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FunctionSecret {
  id: string;
  projectId: string;
  key: string;
  createdAt: string;
  updatedAt: string;
}

interface FunctionSchedule {
  id: string;
  functionId: string;
  cronExpression: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FunctionLog {
  id: string;
  functionId: string;
  executionId: string;
  level: 'info' | 'warn' | 'error';
  message: string | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface InvokeResult {
  success: boolean;
  data?: unknown;
  error?: { message: string };
  duration: number;
  executionId: string;
}

// Foreign Key Types
export interface ForeignKeyDetail {
  constraintName: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete: string;
  onUpdate: string;
}

export type { EdgeFunction, FunctionSecret, FunctionSchedule, FunctionLog, InvokeResult };

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  getToken() {
    return this.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};

    // Only set Content-Type when there's a body to send
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(`${API_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      // Handle 204 No Content (successful DELETE)
      if (response.status === 204) {
        return { success: true };
      }

      // Handle non-JSON responses
      const contentType = response.headers.get('content-type');
      if (!contentType?.includes('application/json')) {
        return {
          success: false,
          error: { code: 'INVALID_RESPONSE', message: 'Invalid server response' },
        };
      }

      return response.json();
    } catch (error) {
      // Handle network errors
      return {
        success: false,
        error: { code: 'NETWORK_ERROR', message: '网络连接失败' },
      };
    }
  }

  // Auth
  async login(email: string, password: string) {
    return this.request<{ user_id: string; email: string; token: string }>(
      'POST',
      '/api/v1/auth/login',
      { email, password }
    );
  }

  async register(email: string, password: string, username?: string) {
    return this.request<{ user_id: string; email: string; token: string }>(
      'POST',
      '/api/v1/auth/register',
      { email, password, username }
    );
  }

  async getMe() {
    return this.request<{
      userId: string;
      email: string;
      username: string | null;
      avatarUrl: string | null;
      role: 'super_admin' | 'admin';
    }>('GET', '/api/v1/users/me');
  }

  // Tenants
  async listTenants() {
    return this.request<Array<{
      tenantId: string;
      alias: string;
      name: string;
      plan: string;
      status: string;
    }>>('GET', '/api/v1/tenants');
  }

  async createTenant(data: { alias: string; name: string; plan?: string }) {
    return this.request<{
      tenantId: string;
      alias: string;
      name: string;
    }>('POST', '/api/v1/tenants', data);
  }

  async getTenant(tenantId: string) {
    return this.request<{
      tenantId: string;
      alias: string;
      name: string;
      plan: string;
      status: string;
      settings: Record<string, unknown>;
    }>('GET', `/api/v1/tenants/${tenantId}`);
  }

  async deleteTenant(tenantId: string) {
    return this.request<void>('DELETE', `/api/v1/tenants/${tenantId}`);
  }

  // Projects
  async listProjects(tenantId: string) {
    return this.request<Array<{
      projectId: string;
      alias: string;
      name: string;
      schemaName: string;
      status: string;
    }>>('GET', `/api/v1/tenants/${tenantId}/projects`);
  }

  async createProject(tenantId: string, data: { alias: string; name: string }) {
    return this.request<{
      projectId: string;
      alias: string;
      name: string;
    }>('POST', `/api/v1/tenants/${tenantId}/projects`, data);
  }

  async getProject(projectId: string) {
    return this.request<{
      projectId: string;
      tenantId: string;
      alias: string;
      name: string;
      schemaName: string;
      settings: Record<string, unknown>;
      status: string;
    }>('GET', `/api/v1/projects/${projectId}`);
  }

  async updateProject(projectId: string, data: { name?: string; status?: string; settings?: Record<string, unknown> }) {
    return this.request<{
      projectId: string;
      name: string;
      settings: Record<string, unknown>;
      status: string;
    }>('PATCH', `/api/v1/projects/${projectId}`, data);
  }

  async deleteProject(projectId: string) {
    return this.request<void>('DELETE', `/api/v1/projects/${projectId}`);
  }

  async executeQuery(projectId: string, sql: string) {
    return this.request<{
      rows: Array<Record<string, unknown>>;
      columns: Array<{ name: string; type: string }>;
      rowCount: number;
    }>('POST', `/api/v1/projects/${projectId}/query`, { sql });
  }

  async executeDdl(projectId: string, sql: string) {
    return this.request<{
      rows: Array<Record<string, unknown>>;
      columns: Array<{ name: string; type: string }>;
      rowCount: number;
    }>('POST', `/api/v1/projects/${projectId}/ddl`, { sql });
  }

  // Tables
  async listTables(schemaName: string) {
    return this.request<Array<{
      tableName: string;
      rowCount: number;
      sizeBytes: number;
    }>>('GET', `/api/v1/schemas/${schemaName}/tables`);
  }

  async getHasuraStatus(schemaName: string) {
    return this.request<Record<string, { tracked: boolean; roles: string[] }>>('GET', `/api/v1/schemas/${schemaName}/hasura/status`);
  }

  async trackAllTablesInHasura(schemaName: string) {
    return this.request<{ tracked: string[]; failed: string[]; relationships: number; untracked: number }>('POST', `/api/v1/schemas/${schemaName}/hasura/track-all`);
  }

  async createTable(schemaName: string, table: {
    name: string;
    columns: Array<{
      name: string;
      type: string;
      nullable?: boolean;
      primaryKey?: boolean;
      defaultValue?: string;
    }>;
  }) {
    return this.request<unknown>('POST', `/api/v1/schemas/${schemaName}/tables`, table);
  }

  async getTableStructure(schemaName: string, tableName: string) {
    return this.request<{
      tableName: string;
      columns: Array<{
        name: string;
        type: string;
        nullable: boolean;
        primaryKey: boolean;
        defaultValue: string | null;
      }>;
    }>('GET', `/api/v1/schemas/${schemaName}/tables/${tableName}`);
  }

  async updateTableStructure(schemaName: string, tableName: string, changes: {
    addColumns?: Array<{
      name: string;
      type: string;
      nullable?: boolean;
      defaultValue?: string;
    }>;
    dropColumns?: string[];
    alterColumns?: Array<{
      name: string;
      type?: string;
      nullable?: boolean;
      defaultValue?: string | null;
    }>;
  }) {
    return this.request<unknown>('PATCH', `/api/v1/schemas/${schemaName}/tables/${tableName}`, changes);
  }

  async dropTable(schemaName: string, tableName: string) {
    return this.request<void>('DELETE', `/api/v1/schemas/${schemaName}/tables/${tableName}`);
  }

  async getSchemaMetadata(schemaName: string) {
    return this.request<{
      tables: Array<{
        name: string;
        columns: Array<{
          name: string;
          type: string;
        }>;
      }>;
    }>('GET', `/api/v1/schemas/${schemaName}/metadata`);
  }

  // Schema Relations for ER diagram
  async getSchemaRelations(schemaName: string) {
    return this.request<{
      tables: Array<{
        name: string;
        columns: Array<{ name: string; type: string; isPrimaryKey: boolean }>;
      }>;
      foreignKeys: Array<{
        fromTable: string;
        fromColumn: string;
        toTable: string;
        toColumn: string;
      }>;
    }>('GET', `/api/v1/schemas/${schemaName}/relations`);
  }

  // Table Rows (Data CRUD)
  async listRows(schemaName: string, tableName: string, options?: {
    limit?: number;
    offset?: number;
    orderBy?: string;
    orderDir?: 'asc' | 'desc';
    filters?: Array<{
      column: string;
      operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is_null' | 'is_not_null';
      value?: string | number | boolean | null;
    }>;
  }) {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    if (options?.orderBy) params.set('order_by', options.orderBy);
    if (options?.orderDir) params.set('order_dir', options.orderDir);
    if (options?.filters) params.set('filters', JSON.stringify(options.filters));
    const query = params.toString();
    return this.request<{
      rows: Array<Record<string, unknown>>;
      total: number;
      columns: Array<{ name: string; type: string }>;
    }>('GET', `/api/v1/schemas/${schemaName}/tables/${tableName}/rows${query ? `?${query}` : ''}`);
  }

  async createRow(schemaName: string, tableName: string, data: Record<string, unknown>) {
    return this.request<Record<string, unknown>>(
      'POST',
      `/api/v1/schemas/${schemaName}/tables/${tableName}/rows`,
      data
    );
  }

  async updateRow(schemaName: string, tableName: string, primaryKey: Record<string, unknown>, data: Record<string, unknown>) {
    return this.request<Record<string, unknown>>(
      'PATCH',
      `/api/v1/schemas/${schemaName}/tables/${tableName}/rows`,
      { primaryKey, data }
    );
  }

  async deleteRow(schemaName: string, tableName: string, primaryKey: Record<string, unknown>) {
    return this.request<void>(
      'DELETE',
      `/api/v1/schemas/${schemaName}/tables/${tableName}/rows`,
      { primaryKey }
    );
  }

  async deleteRows(schemaName: string, tableName: string, primaryKeys: Array<Record<string, unknown>>) {
    return this.request<{ deleted: number }>(
      'DELETE',
      `/api/v1/schemas/${schemaName}/tables/${tableName}/rows/batch`,
      { primaryKeys }
    );
  }

  // Data Export
  async exportData(schemaName: string, tableName: string, format: 'csv' | 'json', options?: {
    filters?: Array<{
      column: string;
      operator: string;
      value?: unknown;
    }>;
  }): Promise<Blob> {
    const params = new URLSearchParams();
    params.set('format', format);
    if (options?.filters) {
      params.set('filters', JSON.stringify(options.filters));
    }

    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(
      `${API_URL}/api/v1/schemas/${schemaName}/tables/${tableName}/export?${params}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error('Export failed');
    }

    return response.blob();
  }

  // Backups
  async listBackups(tenantId: string) {
    return this.request<Array<{
      backupId: string;
      schemaName: string;
      status: string;
      sizeBytes: number;
      createdAt: string;
    }>>('GET', `/api/v1/tenants/${tenantId}/backups`);
  }

  async createBackup(tenantId: string, schemaName: string, projectId?: string) {
    return this.request<{
      backupId: string;
      status: string;
    }>('POST', `/api/v1/tenants/${tenantId}/backups`, { schemaName, projectId });
  }

  // Users (Admin)
  async listUsers(options?: { limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<Array<{
      userId: string;
      email: string | null;
      username: string | null;
      status: string;
      createdAt: string;
    }>>('GET', `/api/v1/users${query ? `?${query}` : ''}`);
  }

  async getUser(userId: string) {
    return this.request<{
      userId: string;
      email: string | null;
      username: string | null;
      avatarUrl: string | null;
      status: string;
      createdAt: string;
    }>('GET', `/api/v1/users/${userId}`);
  }

  async deleteUser(userId: string) {
    return this.request<void>('DELETE', `/api/v1/users/${userId}`);
  }

  async updateUserStatus(userId: string, status: string) {
    return this.request<{
      userId: string;
      status: string;
    }>('PATCH', `/api/v1/users/${userId}/status`, { status });
  }

  // User management (super_admin)
  async createUser(data: { email: string; username: string; password: string; role: string }) {
    return this.request<{
      userId: string;
      email: string;
      username: string;
      role: string;
    }>('POST', '/api/v1/users', data);
  }

  async updateUser(userId: string, data: { username?: string; email?: string; role?: string }) {
    return this.request<{
      userId: string;
      email: string | null;
      username: string | null;
      role: string;
    }>('PATCH', `/api/v1/users/${userId}`, data);
  }

  async resetUserPassword(userId: string) {
    return this.request<{ tempPassword: string }>('POST', `/api/v1/users/${userId}/reset-password`, {});
  }

  // Settings
  async getSettings() {
    return this.request<{
      defaultPlan: string;
      defaultStorageLimit: number;
      defaultProjectLimit: number;
      defaultUserLimit: number;
      backupRetentionDays: number;
      backupMaxCount: number;
    }>('GET', '/api/v1/settings');
  }

  async updateSettings(data: {
    defaultPlan?: string;
    defaultStorageLimit?: number;
    defaultProjectLimit?: number;
    defaultUserLimit?: number;
    backupRetentionDays?: number;
    backupMaxCount?: number;
  }) {
    return this.request<{
      defaultPlan: string;
      defaultStorageLimit: number;
      defaultProjectLimit: number;
      defaultUserLimit: number;
      backupRetentionDays: number;
      backupMaxCount: number;
    }>('PATCH', '/api/v1/settings', data);
  }

  // Profile
  async updateProfile(data: { username?: string; email?: string }) {
    return this.request<{
      userId: string;
      email: string | null;
      username: string | null;
    }>('PATCH', '/api/v1/users/me', data);
  }

  async changePassword(data: { currentPassword: string; newPassword: string }) {
    return this.request<{ success: boolean }>('POST', '/api/v1/users/me/password', data);
  }

  // Dashboard
  async getDashboardStats() {
    return this.request<{
      tenants: { total: number; weekNew: number };
      users: { total: number; weekNew: number };
      backups: { total: number; weekNew: number };
      storage: { used: number; total: number };
    }>('GET', '/api/v1/dashboard/stats');
  }

  async getDashboardTrends(days = 7) {
    return this.request<Array<{
      date: string;
      tenants: number;
      users: number;
      backups: number;
    }>>('GET', `/api/v1/dashboard/trends?days=${days}`);
  }

  async getDashboardActivities(limit = 20, offset = 0) {
    return this.request<{
      activities: Array<{
        id: string;
        userId: string | null;
        action: string;
        targetType: string | null;
        targetId: string | null;
        details: Record<string, unknown> | null;
        createdAt: string;
      }>;
      total: number;
    }>('GET', `/api/v1/dashboard/activities?limit=${limit}&offset=${offset}`);
  }

  async getDashboardResources() {
    return this.request<{
      topTenants: Array<{ name: string; size: number }>;
      storageByTenant: Array<{ name: string; size: number }>;
    }>('GET', '/api/v1/dashboard/resources');
  }

  // Backups (global)
  async listAllBackups(options?: { tenantId?: string; projectId?: string; limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (options?.tenantId) params.set('tenantId', options.tenantId);
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<{
      backups: Array<{
        backupId: string;
        tenantId: string;
        projectId: string | null;
        schemaName: string;
        status: string;
        sizeBytes: number;
        createdAt: string;
      }>;
      total: number;
    }>('GET', `/api/v1/backups${query ? `?${query}` : ''}`);
  }

  async downloadBackup(backupId: string) {
    return this.request<{ url: string }>('GET', `/api/v1/backups/${backupId}/download`);
  }

  async restoreBackup(backupId: string) {
    return this.request<{ success: boolean }>('POST', `/api/v1/backups/${backupId}/restore`);
  }

  async deleteBackup(backupId: string) {
    return this.request<void>('DELETE', `/api/v1/backups/${backupId}`);
  }

  // Tenant update
  async updateTenant(tenantId: string, data: {
    name?: string;
    description?: string;
    plan?: string;
    status?: string;
    storageLimit?: number;
    projectLimit?: number;
    userLimit?: number;
  }) {
    return this.request<{
      tenantId: string;
      name: string;
      description: string | null;
      plan: string;
      status: string;
      storageLimit: number;
      projectLimit: number;
      userLimit: number;
    }>('PATCH', `/api/v1/tenants/${tenantId}`, data);
  }

  async getTenantUsage(tenantId: string) {
    return this.request<{
      storage: { used: number; limit: number };
      projects: { used: number; limit: number };
      users: { used: number; limit: number };
    }>('GET', `/api/v1/tenants/${tenantId}/usage`);
  }

  // Project Database Credentials
  async getProjectDbInfo(projectId: string) {
    return this.request<{
      username: string | null;
      host: string;
      port: number;
      database: string;
      schemaName: string | null;
      hasCredentials: boolean;
      createdAt: string | null;
    }>('GET', `/api/v1/projects/${projectId}/db`);
  }

  async createProjectDbUser(projectId: string) {
    return this.request<{
      username: string;
      password: string;
      host: string;
      port: number;
      database: string;
      schemaName: string;
    }>('POST', `/api/v1/projects/${projectId}/db/user`, {});
  }

  async resetProjectDbPassword(projectId: string) {
    return this.request<{
      username: string;
      password: string;
      host: string;
      port: number;
      database: string;
      schemaName: string;
    }>('POST', `/api/v1/projects/${projectId}/db/reset-password`, {});
  }

  async deleteProjectDbUser(projectId: string) {
    return this.request<void>('DELETE', `/api/v1/projects/${projectId}/db/user`);
  }

  // ============================================
  // Storage Buckets
  // ============================================

  async listBuckets(projectId: string) {
    return this.request<Array<{
      bucketId: string;
      projectId: string;
      name: string;
      public: boolean;
      fileSizeLimit: number | null;
      allowedMimeTypes: string[] | null;
      createdAt: string;
      updatedAt: string;
    }>>('GET', `/api/v1/projects/${projectId}/storage/buckets`);
  }

  async createBucket(
    projectId: string,
    data: { name: string; public?: boolean; fileSizeLimit?: number; allowedMimeTypes?: string[] }
  ) {
    return this.request<{
      bucketId: string;
      projectId: string;
      name: string;
      public: boolean;
      fileSizeLimit: number | null;
      allowedMimeTypes: string[] | null;
    }>('POST', `/api/v1/projects/${projectId}/storage/buckets`, data);
  }

  async getBucket(projectId: string, bucketName: string) {
    return this.request<{
      bucketId: string;
      projectId: string;
      name: string;
      public: boolean;
      fileSizeLimit: number | null;
      allowedMimeTypes: string[] | null;
      corsConfig: Record<string, unknown> | null;
      createdAt: string;
      updatedAt: string;
    }>('GET', `/api/v1/projects/${projectId}/storage/buckets/${bucketName}`);
  }

  async updateBucket(
    projectId: string,
    bucketName: string,
    data: Partial<{
      public: boolean;
      fileSizeLimit: number | null;
      allowedMimeTypes: string[] | null;
      corsConfig: Record<string, unknown> | null;
    }>
  ) {
    return this.request<{
      bucketId: string;
      name: string;
      public: boolean;
      fileSizeLimit: number | null;
      allowedMimeTypes: string[] | null;
    }>('PATCH', `/api/v1/projects/${projectId}/storage/buckets/${bucketName}`, data);
  }

  async deleteBucket(projectId: string, bucketName: string) {
    return this.request<void>('DELETE', `/api/v1/projects/${projectId}/storage/buckets/${bucketName}`);
  }

  // ============================================
  // Storage Objects
  // ============================================

  async listObjects(
    projectId: string,
    bucketName: string,
    options?: { prefix?: string; limit?: number; offset?: number }
  ) {
    const params = new URLSearchParams();
    if (options?.prefix) params.set('prefix', options.prefix);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<Array<{
      objectId: string;
      bucketId: string;
      name: string;
      size: number;
      mimeType: string | null;
      createdAt: string;
      updatedAt: string;
    }>>('GET', `/api/v1/projects/${projectId}/storage/buckets/${bucketName}/objects${query ? `?${query}` : ''}`);
  }

  async uploadObject(projectId: string, bucketName: string, file: File, fileName?: string): Promise<ApiResponse<{
    objectId: string;
    bucketId: string;
    name: string;
    size: number;
    mimeType: string | null;
  }>> {
    const formData = new FormData();
    formData.append('file', file);

    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const pathParam = fileName ? `?path=${encodeURIComponent(fileName)}` : '';

    try {
      const response = await fetch(
        `${API_URL}/api/v1/projects/${projectId}/storage/buckets/${bucketName}/objects${pathParam}`,
        {
          method: 'POST',
          headers,
          body: formData,
        }
      );

      if (response.status === 204) {
        return { success: true };
      }

      return response.json();
    } catch (error) {
      return {
        success: false,
        error: { code: 'NETWORK_ERROR', message: '网络连接失败' },
      };
    }
  }

  async downloadObject(projectId: string, bucketName: string, objectPath: string): Promise<Blob> {
    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(
      `${API_URL}/api/v1/projects/${projectId}/storage/buckets/${bucketName}/objects/${objectPath}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error('Download failed');
    }

    return response.blob();
  }

  async deleteObject(projectId: string, bucketName: string, objectPath: string) {
    return this.request<void>(
      'DELETE',
      `/api/v1/projects/${projectId}/storage/buckets/${bucketName}/objects/${objectPath}`
    );
  }

  async getObjectSignedUrl(
    projectId: string,
    bucketName: string,
    objectPath: string,
    expiresIn?: number
  ) {
    return this.request<{ url: string; expiresIn: number | null }>(
      'POST',
      `/api/v1/projects/${projectId}/storage/buckets/${bucketName}/signed-url`,
      { objectPath, expiresIn }
    );
  }

  // ============================================
  // Authentication Admin - Providers
  // ============================================

  async listAuthProviders(projectId: string) {
    return this.request<Array<{
      id: string;
      name: string;
      type: 'builtin' | 'oauth';
      enabled: boolean;
      configured: boolean;
      hasCredentials: boolean;
    }>>('GET', `/api/v1/projects/${projectId}/auth/providers`);
  }

  async getAuthProvider(projectId: string, provider: string) {
    return this.request<{
      id: number;
      projectId: string;
      provider: string;
      enabled: boolean;
      clientId: string | null;
      config: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }>('GET', `/api/v1/projects/${projectId}/auth/providers/${provider}`);
  }

  async createAuthProvider(
    projectId: string,
    data: {
      provider: string;
      enabled?: boolean;
      clientId?: string;
      clientSecret?: string;
      config?: Record<string, unknown>;
    }
  ) {
    return this.request<{
      id: number;
      projectId: string;
      provider: string;
      enabled: boolean;
      clientId: string | null;
      config: Record<string, unknown>;
    }>('POST', `/api/v1/projects/${projectId}/auth/providers`, data);
  }

  async updateAuthProvider(
    projectId: string,
    provider: string,
    data: {
      enabled?: boolean;
      clientId?: string;
      clientSecret?: string;
      config?: Record<string, unknown>;
    }
  ) {
    return this.request<{
      id: number;
      projectId: string;
      provider: string;
      enabled: boolean;
      clientId: string | null;
      config: Record<string, unknown>;
    }>('PATCH', `/api/v1/projects/${projectId}/auth/providers/${provider}`, data);
  }

  async deleteAuthProvider(projectId: string, provider: string) {
    return this.request<void>('DELETE', `/api/v1/projects/${projectId}/auth/providers/${provider}`);
  }

  async getSupportedAuthProviders() {
    return this.request<Array<{
      id: string;
      name: string;
      type: 'builtin' | 'oauth';
    }>>('GET', '/api/v1/auth/providers/supported');
  }

  // ============================================
  // Authentication Admin - Config
  // ============================================

  async getAuthConfig(projectId: string) {
    return this.request<{
      projectId: string;
      jwtExpiresIn: number;
      refreshTokenExpiresIn: number;
      passwordMinLength: number;
      requireEmailVerification: boolean;
      allowSignup: boolean;
    }>('GET', `/api/v1/projects/${projectId}/auth/config`);
  }

  async updateAuthConfig(
    projectId: string,
    data: {
      jwtExpiresIn?: number;
      refreshTokenExpiresIn?: number;
      passwordMinLength?: number;
      requireEmailVerification?: boolean;
      allowSignup?: boolean;
    }
  ) {
    return this.request<{
      projectId: string;
      jwtExpiresIn: number;
      refreshTokenExpiresIn: number;
      passwordMinLength: number;
      requireEmailVerification: boolean;
      allowSignup: boolean;
    }>('PUT', `/api/v1/projects/${projectId}/auth/config`, data);
  }

  // ============================================
  // Authentication Admin - Users
  // ============================================

  async listProjectUsers(
    projectId: string,
    options?: { limit?: number; offset?: number; status?: string; search?: string }
  ) {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    if (options?.status) params.set('status', options.status);
    if (options?.search) params.set('search', options.search);
    const query = params.toString();
    return this.request<Array<{
      id: string;
      email: string;
      username: string | null;
      avatarUrl: string | null;
      provider: string;
      providerId: string | null;
      status: 'active' | 'disabled';
      lastLoginAt: string | null;
      createdAt: string;
    }>>('GET', `/api/v1/projects/${projectId}/auth/users${query ? `?${query}` : ''}`) as Promise<{
      success: boolean;
      data?: Array<{
        id: string;
        email: string;
        username: string | null;
        avatarUrl: string | null;
        provider: string;
        providerId: string | null;
        status: 'active' | 'disabled';
        lastLoginAt: string | null;
        createdAt: string;
      }>;
      pagination?: { limit: number; offset: number; total: number };
      error?: { code: string; message: string };
    }>;
  }

  async getProjectUser(projectId: string, userId: string) {
    return this.request<{
      id: string;
      email: string;
      username: string | null;
      avatarUrl: string | null;
      provider: string;
      providerId: string | null;
      status: 'active' | 'disabled';
      lastLoginAt: string | null;
      createdAt: string;
    }>('GET', `/api/v1/projects/${projectId}/auth/users/${userId}`);
  }

  async updateProjectUser(
    projectId: string,
    userId: string,
    data: { status?: 'active' | 'disabled' }
  ) {
    return this.request<{
      id: string;
      email: string;
      username: string | null;
      status: 'active' | 'disabled';
    }>('PATCH', `/api/v1/projects/${projectId}/auth/users/${userId}`, data);
  }

  async deleteProjectUser(projectId: string, userId: string) {
    return this.request<void>('DELETE', `/api/v1/projects/${projectId}/auth/users/${userId}`);
  }

  // ============================================
  // Realtime
  // ============================================

  async listRealtimeSubscriptions(projectId: string, envName?: string) {
    const params = envName && envName !== 'prod' ? `?env=${envName}` : '';
    return this.request<{
      subscriptions: Array<{
        tableName: string;
        schemaName: string;
        enabled: boolean;
        operations: ('INSERT' | 'UPDATE' | 'DELETE')[];
        hasSelectPermission: boolean;
      }>;
      stats: {
        totalTables: number;
        enabledTables: number;
        disabledTables: number;
      };
    }>('GET', `/api/v1/projects/${projectId}/realtime/subscriptions${params}`);
  }

  async configureRealtimeSubscription(
    projectId: string,
    tableName: string,
    data: { enabled: boolean },
    envName?: string
  ) {
    const params = envName && envName !== 'prod' ? `?env=${envName}` : '';
    return this.request<{
      tableName: string;
      schemaName: string;
      enabled: boolean;
      operations: ('INSERT' | 'UPDATE' | 'DELETE')[];
      hasSelectPermission: boolean;
    }>('POST', `/api/v1/projects/${projectId}/realtime/subscriptions/${tableName}${params}`, data);
  }

  async getRealtimeConfig(projectId: string, envName?: string) {
    const params = envName && envName !== 'prod' ? `?env=${envName}` : '';
    return this.request<{
      schemaName: string;
      websocketEndpoint: string;
      graphqlEndpoint: string;
      hasuraConnected: boolean;
    }>('GET', `/api/v1/projects/${projectId}/realtime/config${params}`);
  }

  async getSubscriptionExample(projectId: string, tableName: string, operation?: string, envName?: string) {
    const queryParams: string[] = [];
    if (operation) queryParams.push(`operation=${operation}`);
    if (envName && envName !== 'prod') queryParams.push(`env=${envName}`);
    const params = queryParams.length > 0 ? `?${queryParams.join('&')}` : '';
    return this.request<Array<{
      language: 'javascript' | 'graphql';
      code: string;
      description: string;
    }>>('GET', `/api/v1/projects/${projectId}/realtime/subscriptions/${tableName}/example${params}`);
  }

  async listRealtimeTables(projectId: string, envName?: string) {
    const params = envName && envName !== 'prod' ? `?env=${envName}` : '';
    return this.request<Array<{
      tableName: string;
      schemaName: string;
    }>>('GET', `/api/v1/projects/${projectId}/realtime/tables${params}`);
  }

  // ============================================
  // SQL Import/Export
  // ============================================

  async listExportableTables(projectId: string) {
    return this.request<Array<{
      name: string;
      rowCount: number;
    }>>('GET', `/api/v1/projects/${projectId}/sql/tables`);
  }

  async exportSql(
    projectId: string,
    options?: { tables?: string[]; includeData?: boolean; includeDrops?: boolean }
  ): Promise<Blob> {
    const params = new URLSearchParams();
    if (options?.tables?.length) params.set('tables', options.tables.join(','));
    if (options?.includeData) params.set('includeData', 'true');
    if (options?.includeDrops) params.set('includeDrops', 'true');

    const query = params.toString();
    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(
      `${API_URL}/api/v1/projects/${projectId}/sql/export${query ? `?${query}` : ''}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error('Export failed');
    }

    return response.blob();
  }

  async importSql(projectId: string, file: File): Promise<ApiResponse<{
    statementsExecuted: number;
    errors: string[];
  }>> {
    const formData = new FormData();
    formData.append('file', file);

    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(
        `${API_URL}/api/v1/projects/${projectId}/sql/import`,
        {
          method: 'POST',
          headers,
          body: formData,
        }
      );

      return response.json();
    } catch (error) {
      return {
        success: false,
        error: { code: 'NETWORK_ERROR', message: '网络连接失败' },
      };
    }
  }

  async importSqlText(projectId: string, sql: string): Promise<ApiResponse<{
    statementsExecuted: number;
    errors: string[];
  }>> {
    return this.request('POST', `/api/v1/projects/${projectId}/sql/import`, { sql });
  }

  // ============================================
  // Functions API
  // ============================================

  async listFunctions(projectId: string): Promise<ApiResponse<EdgeFunction[]>> {
    return this.request('GET', `/api/v1/projects/${projectId}/functions`);
  }

  async createFunction(projectId: string, data: { name: string; code: string; description?: string; invokeAuthMode?: 'jwt_required' | 'anon_allowed' }): Promise<ApiResponse<EdgeFunction>> {
    return this.request('POST', `/api/v1/projects/${projectId}/functions`, data);
  }

  async getFunction(projectId: string, name: string): Promise<ApiResponse<EdgeFunction>> {
    return this.request('GET', `/api/v1/projects/${projectId}/functions/${encodeURIComponent(name)}`);
  }

  async updateFunction(projectId: string, name: string, data: { code?: string; status?: string; description?: string; invokeAuthMode?: 'jwt_required' | 'anon_allowed' }): Promise<ApiResponse<EdgeFunction>> {
    return this.request('PUT', `/api/v1/projects/${projectId}/functions/${encodeURIComponent(name)}`, data);
  }

  async deleteFunction(projectId: string, name: string): Promise<ApiResponse<void>> {
    return this.request('DELETE', `/api/v1/projects/${projectId}/functions/${encodeURIComponent(name)}`);
  }

  async invokeFunction(projectId: string, name: string, payload?: unknown): Promise<ApiResponse<InvokeResult>> {
    return this.request('POST', `/api/v1/projects/${projectId}/functions/${encodeURIComponent(name)}/invoke`, { payload });
  }

  async getFunctionLogs(projectId: string, name: string, options?: { limit?: number; offset?: number; level?: string }): Promise<ApiResponse<FunctionLog[]>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    if (options?.level) params.set('level', options.level);
    const query = params.toString();
    return this.request('GET', `/api/v1/projects/${projectId}/functions/${encodeURIComponent(name)}/logs${query ? `?${query}` : ''}`);
  }

  // Secrets
  async listSecrets(projectId: string): Promise<ApiResponse<FunctionSecret[]>> {
    return this.request('GET', `/api/v1/projects/${projectId}/functions/secrets`);
  }

  async createSecret(projectId: string, key: string, value: string): Promise<ApiResponse<FunctionSecret>> {
    return this.request('POST', `/api/v1/projects/${projectId}/functions/secrets`, { key, value });
  }

  async deleteSecret(projectId: string, key: string): Promise<ApiResponse<void>> {
    return this.request('DELETE', `/api/v1/projects/${projectId}/functions/secrets/${encodeURIComponent(key)}`);
  }

  // Schedules
  async listSchedules(projectId: string, functionName: string): Promise<ApiResponse<FunctionSchedule[]>> {
    return this.request('GET', `/api/v1/projects/${projectId}/functions/${encodeURIComponent(functionName)}/schedules`);
  }

  async createSchedule(projectId: string, functionName: string, cronExpression: string): Promise<ApiResponse<FunctionSchedule>> {
    return this.request('POST', `/api/v1/projects/${projectId}/functions/${encodeURIComponent(functionName)}/schedules`, { cronExpression });
  }

  async updateSchedule(projectId: string, functionName: string, scheduleId: string, data: { cronExpression?: string; enabled?: boolean }): Promise<ApiResponse<FunctionSchedule>> {
    return this.request('PATCH', `/api/v1/projects/${projectId}/functions/${encodeURIComponent(functionName)}/schedules/${scheduleId}`, data);
  }

  async deleteSchedule(projectId: string, functionName: string, scheduleId: string): Promise<ApiResponse<void>> {
    return this.request('DELETE', `/api/v1/projects/${projectId}/functions/${encodeURIComponent(functionName)}/schedules/${scheduleId}`);
  }

  // ============================================
  // Foreign Keys
  // ============================================

  async getTableForeignKeys(schemaName: string, tableName: string): Promise<ApiResponse<ForeignKeyDetail[]>> {
    return this.request('GET', `/api/v1/schemas/${schemaName}/tables/${tableName}/foreign-keys`);
  }

  async addForeignKey(
    schemaName: string,
    tableName: string,
    config: {
      column: string;
      targetTable: string;
      targetColumn: string;
      onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
      onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
    }
  ): Promise<ApiResponse<{ constraintName: string }>> {
    return this.request('POST', `/api/v1/schemas/${schemaName}/tables/${tableName}/foreign-keys`, config);
  }

  async dropForeignKey(
    schemaName: string,
    tableName: string,
    constraintName: string
  ): Promise<ApiResponse<void>> {
    return this.request('DELETE', `/api/v1/schemas/${schemaName}/tables/${tableName}/foreign-keys/${constraintName}`);
  }

  // ============================================
  // Environments
  // ============================================

  async listEnvironments(projectId: string) {
    return this.request<Array<{
      id: number;
      projectId: string;
      envName: string;
      schemaName: string;
      createdAt: string;
    }>>('GET', `/api/v1/projects/${projectId}/environments`);
  }

  async createEnvironment(projectId: string, envName: string, cloneData?: boolean) {
    return this.request<{
      id: number;
      projectId: string;
      envName: string;
      schemaName: string;
      createdAt: string;
    }>('POST', `/api/v1/projects/${projectId}/environments`, { envName, cloneData });
  }

  async deleteEnvironment(projectId: string, envName: string) {
    return this.request<void>('DELETE', `/api/v1/projects/${projectId}/environments/${envName}`);
  }

  // ============================================
  // API Keys
  // ============================================

  async listApiKeys(projectId: string) {
    return this.request<Array<{
      id: number;
      projectId: string;
      keyPrefix: string;
      name: string | null;
      createdAt: string;
      lastUsedAt: string | null;
    }>>('GET', `/api/v1/projects/${projectId}/api-keys`);
  }

  async createApiKey(projectId: string, name?: string) {
    return this.request<{
      key: string;
      apiKey: {
        id: number;
        projectId: string;
        keyPrefix: string;
        name: string | null;
        createdAt: string;
        lastUsedAt: string | null;
      };
    }>('POST', `/api/v1/projects/${projectId}/api-keys`, { name });
  }

  async deleteApiKey(projectId: string, keyId: number) {
    return this.request<void>('DELETE', `/api/v1/projects/${projectId}/api-keys/${keyId}`);
  }
}

export const api = new ApiClient();
