import { api } from './api';

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
  defaultValue?: string | null;
}

export interface DataProviderOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  filters?: FilterCondition[];
}

export interface FilterCondition {
  column: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is_null' | 'is_not_null';
  value?: string | number | boolean | null;
}

/**
 * DruviaDataProvider - 适配 SVAR DataGrid 与 Druvia API
 *
 * 解决的兼容性问题：
 * 1. 响应格式：Druvia 返回 { success, data } vs SVAR 期望直接数据
 * 2. 更新操作：Druvia 用 body { primaryKey, data } vs SVAR 用 URL /:id
 * 3. 删除操作：Druvia 用 body { primaryKey } vs SVAR 用 URL /:id
 */
export class DruviaDataProvider {
  constructor(
    private schemaName: string,
    private tableName: string,
    private primaryKeyColumn: string = 'id'
  ) {}

  /**
   * 获取数据 - 转换响应格式
   */
  async getData(options?: DataProviderOptions): Promise<{
    rows: Record<string, unknown>[];
    total: number;
    columns: ColumnInfo[];
  }> {
    const res = await api.listRows(this.schemaName, this.tableName, {
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
      orderBy: options?.orderBy,
      orderDir: options?.orderDir,
      filters: options?.filters,
    });

    if (!res.success || !res.data) {
      throw new Error(res.error?.message || 'Failed to load data');
    }

    return {
      rows: res.data.rows,
      total: res.data.total,
      columns: res.data.columns,
    };
  }

  /**
   * 处理 Grid 事件 - 转换为 Druvia API 调用
   */
  async handleEvent(
    event: 'add-row' | 'update-row' | 'update-cell' | 'delete-row',
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown> | void> {
    switch (event) {
      case 'add-row':
        return this.addRow(payload.row as Record<string, unknown>);

      case 'update-row':
      case 'update-cell':
        return this.updateRow(
          payload.id as unknown,
          (payload.row || payload.data) as Record<string, unknown>
        );

      case 'delete-row':
        return this.deleteRow(payload.id as unknown);

      default:
        console.warn(`Unknown event: ${event}`);
    }
  }

  private async addRow(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await api.createRow(this.schemaName, this.tableName, row);
    if (!res.success) {
      throw new Error(res.error?.message || 'Create failed');
    }
    return res.data as Record<string, unknown>;
  }

  private async updateRow(
    id: unknown,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const primaryKey = { [this.primaryKeyColumn]: id };
    const res = await api.updateRow(this.schemaName, this.tableName, primaryKey, data);
    if (!res.success) {
      throw new Error(res.error?.message || 'Update failed');
    }
    return res.data as Record<string, unknown>;
  }

  private async deleteRow(id: unknown): Promise<void> {
    const primaryKey = { [this.primaryKeyColumn]: id };
    const res = await api.deleteRow(this.schemaName, this.tableName, primaryKey);
    if (!res.success) {
      throw new Error(res.error?.message || 'Delete failed');
    }
  }

  /**
   * 批量删除
   */
  async deleteRows(ids: unknown[]): Promise<number> {
    const primaryKeys = ids.map((id) => ({ [this.primaryKeyColumn]: id }));
    const res = await api.deleteRows(this.schemaName, this.tableName, primaryKeys);
    if (!res.success) {
      throw new Error(res.error?.message || 'Batch delete failed');
    }
    return res.data?.deleted ?? 0;
  }
}
