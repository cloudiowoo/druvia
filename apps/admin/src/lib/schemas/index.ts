// apps/admin/src/lib/schemas/index.ts
import { z } from 'zod';

// 列名验证：小写字母或下划线开头，只含小写字母、数字、下划线
export const columnNameSchema = z.string()
  .min(1, '列名不能为空')
  .max(63, '列名最长 63 字符')
  .regex(/^[a-z_][a-z0-9_]*$/, '列名只能包含小写字母、数字和下划线，且以字母或下划线开头');

// 表名验证
export const tableNameSchema = z.string()
  .min(1, '表名不能为空')
  .max(63, '表名最长 63 字符')
  .regex(/^[a-z_][a-z0-9_]*$/, '表名只能包含小写字母、数字和下划线，且以字母或下划线开头');

// 项目名验证
export const projectNameSchema = z.string()
  .min(1, '项目名不能为空')
  .max(100, '项目名最长 100 字符')
  .trim();

// 项目 ID 验证
export const projectIdSchema = z.string()
  .min(1, '项目 ID 不能为空')
  .max(50, '项目 ID 最长 50 字符')
  .regex(/^[a-z0-9_-]+$/, '项目 ID 只能包含小写字母、数字、下划线和连字符');

// 列定义 schema
export const columnSchema = z.object({
  name: columnNameSchema,
  type: z.string().min(1, '请选择列类型'),
  nullable: z.boolean(),
  primaryKey: z.boolean(),
  defaultValue: z.string().optional(),
  references: z.object({
    table: z.string(),
    column: z.string(),
    onDelete: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).optional(),
    onUpdate: z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION']).optional(),
  }).optional(),
});

// 创建表 schema
export const createTableSchema = z.object({
  tableName: tableNameSchema,
  columns: z.array(columnSchema).min(1, '至少需要一个列'),
});

// 创建项目 schema
export const createProjectSchema = z.object({
  name: projectNameSchema,
  projectId: projectIdSchema,
  description: z.string().max(500, '描述最长 500 字符').optional(),
});

export type ColumnInput = z.infer<typeof columnSchema>;
export type CreateTableInput = z.infer<typeof createTableSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
