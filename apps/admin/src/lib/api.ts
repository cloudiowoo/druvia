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
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(`${API_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

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

  async createBackup(tenantId: string, schemaName: string) {
    return this.request<{
      backupId: string;
      status: string;
    }>('POST', `/api/v1/tenants/${tenantId}/backups`, { schemaName });
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
}

export const api = new ApiClient();
