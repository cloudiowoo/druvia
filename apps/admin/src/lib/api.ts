const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

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
      status: string;
    }>('GET', `/api/v1/projects/${projectId}`);
  }

  async updateProject(projectId: string, data: { name?: string; status?: string }) {
    return this.request<{
      projectId: string;
      name: string;
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

  async uploadObject(projectId: string, bucketName: string, file: File): Promise<ApiResponse<{
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

    try {
      const response = await fetch(
        `${API_URL}/api/v1/projects/${projectId}/storage/buckets/${bucketName}/objects`,
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
    return this.request<{ url: string; expiresIn: number }>(
      'POST',
      `/api/v1/projects/${projectId}/storage/buckets/${bucketName}/signed-url`,
      { objectPath, expiresIn }
    );
  }
}

export const api = new ApiClient();
