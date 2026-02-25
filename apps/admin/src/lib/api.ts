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
      '/api/v1/users/login',
      { email, password }
    );
  }

  async register(email: string, password: string, username?: string) {
    return this.request<{ user_id: string; email: string; token: string }>(
      'POST',
      '/api/v1/users/register',
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
    }>;
  }) {
    return this.request<unknown>('POST', `/api/v1/schemas/${schemaName}/tables`, table);
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
}

export const api = new ApiClient();
