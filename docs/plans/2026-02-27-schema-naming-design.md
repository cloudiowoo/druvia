# Schema 命名规范设计

> 日期: 2026-02-27
> 状态: 已批准

## 背景

当前 Schema 命名采用 `tenant_{tenant_alias}_{project_alias}` 模式，存在以下问题：

1. PostgreSQL 标识符限制 63 字符，当前模式最大可达 136 字符
2. 用户可自由输入 alias，长度和字符无约束
3. 下划线同时用于 alias 内部和分隔符，造成解析歧义

## 设计决策

| 决策点 | 选择 |
|--------|------|
| 核心目标 | 混合模式 - 保留可读性，限制长度 |
| 长度策略 | 严格限制用户输入 |
| 迁移策略 | 重置开发数据库，无需迁移 |
| 字符规则 | 仅小写字母和数字 `[a-z0-9]` |
| 命名格式 | `t_{tenant}_{project}` |

## 规范定义

### Alias 规则

| 字段 | 类型 | 长度 | 正则 | 示例 |
|------|------|------|------|------|
| 租户 alias | varchar(16) | 3-16 | `^[a-z0-9]{3,16}$` | `acme`, `corp2024` |
| 项目 alias | varchar(16) | 3-16 | `^[a-z0-9]{3,16}$` | `main`, `api1` |

### Schema 命名

- 格式: `dru_{tenant_alias}_{project_alias}`
- 最大长度: 4 + 16 + 1 + 16 = **37 字符**
- 示例: `dru_acme_main`, `dru_corp2024_api1`

## 实现变更

### 1. 数据库约束

```sql
-- 重置数据库后执行

-- 租户表
ALTER TABLE druvia_tenants
  ALTER COLUMN alias TYPE varchar(16),
  ADD CONSTRAINT chk_tenant_alias CHECK (alias ~ '^[a-z0-9]{3,16}$');

-- 项目表
ALTER TABLE druvia_projects
  ALTER COLUMN alias TYPE varchar(16),
  ADD CONSTRAINT chk_project_alias CHECK (alias ~ '^[a-z0-9]{3,16}$');

-- Schema 名字段
ALTER TABLE druvia_projects
  ALTER COLUMN schema_name TYPE varchar(35);

ALTER TABLE druvia_schema_registry
  ALTER COLUMN schema_name TYPE varchar(35);

ALTER TABLE druvia_backups
  ALTER COLUMN schema_name TYPE varchar(35);
```

### 2. API 验证 (Service 层)

```typescript
// apps/api/src/lib/validation.ts

export function validateAlias(alias: string, field: string): void {
  if (!/^[a-z0-9]{3,16}$/.test(alias)) {
    throw new Error(`${field} 必须是 3-16 个小写字母或数字`);
  }
}

export function generateSchemaName(tenantAlias: string, projectAlias: string): string {
  return `t_${tenantAlias}_${projectAlias}`;
}
```

### 3. 前端验证

| 页面 | 组件 | 变更 |
|------|------|------|
| `/tenants/new` | alias 输入框 | `pattern="[a-z0-9]{3,16}"` |
| `/t/[tenantId]/projects/new` | alias 输入框 | `pattern="[a-z0-9]{3,16}"` |

提示文案: 「3-16 个字符，仅限小写字母和数字」

### 4. 受影响文件

| 文件 | 变更类型 |
|------|----------|
| `apps/api/src/modules/tenant/tenant.service.ts` | 添加 alias 验证 |
| `apps/api/src/modules/project/project.service.ts` | 添加 alias 验证 |
| `apps/api/src/modules/schema/schema.service.ts` | 使用新命名函数 |
| `apps/admin/src/app/tenants/new/page.tsx` | 更新输入约束 |
| `apps/admin/src/app/t/[tenantId]/projects/new/page.tsx` | 更新输入约束 |
| `apps/admin/src/app/backups/page.tsx` | 更新 Schema 名生成 |

## 测试要点

1. 验证 alias 长度边界 (2字符拒绝, 3字符通过, 16字符通过, 17字符拒绝)
2. 验证字符规则 (大写拒绝, 下划线拒绝, 连字符拒绝)
3. 验证 Schema 名生成正确
4. 验证数据库约束生效
