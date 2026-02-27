# Schema 命名规范实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 Schema 命名规范，限制 alias 为 3-16 个小写字母/数字，Schema 格式为 `t_{tenant}_{project}`

**Architecture:** 数据库约束 + API 验证 + 前端验证三层防护，确保 alias 符合规范

**Tech Stack:** PostgreSQL, Node.js/Fastify, Next.js/React

---

## Task 1: 创建验证工具函数

**Files:**
- Create: `apps/api/src/lib/validation.ts`
- Test: `tests/unit/validation.test.ts`

**Step 1: 写失败测试**

```typescript
// tests/unit/validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateAlias, generateSchemaName } from '../../apps/api/src/lib/validation';

describe('validateAlias', () => {
  it('should accept valid alias', () => {
    expect(() => validateAlias('acme', 'tenant')).not.toThrow();
    expect(() => validateAlias('abc', 'tenant')).not.toThrow();
    expect(() => validateAlias('a1b2c3d4e5f6g7h8', 'tenant')).not.toThrow();
  });

  it('should reject too short alias', () => {
    expect(() => validateAlias('ab', 'tenant')).toThrow('tenant 必须是 3-16 个小写字母或数字');
  });

  it('should reject too long alias', () => {
    expect(() => validateAlias('a1b2c3d4e5f6g7h8i', 'tenant')).toThrow();
  });

  it('should reject uppercase', () => {
    expect(() => validateAlias('Acme', 'tenant')).toThrow();
  });

  it('should reject underscore', () => {
    expect(() => validateAlias('acme_corp', 'tenant')).toThrow();
  });

  it('should reject hyphen', () => {
    expect(() => validateAlias('acme-corp', 'tenant')).toThrow();
  });
});

describe('generateSchemaName', () => {
  it('should generate correct schema name', () => {
    expect(generateSchemaName('acme', 'main')).toBe('t_acme_main');
    expect(generateSchemaName('corp2024', 'api1')).toBe('t_corp2024_api1');
  });
});
```

**Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/validation.test.ts`
Expected: FAIL - module not found

**Step 3: 实现验证函数**

```typescript
// apps/api/src/lib/validation.ts
const ALIAS_REGEX = /^[a-z0-9]{3,16}$/;

export function validateAlias(alias: string, field: string): void {
  if (!ALIAS_REGEX.test(alias)) {
    throw new Error(`${field} 必须是 3-16 个小写字母或数字`);
  }
}

export function generateSchemaName(tenantAlias: string, projectAlias: string): string {
  return `t_${tenantAlias}_${projectAlias}`;
}
```

**Step 4: 运行测试确认通过**

Run: `pnpm test tests/unit/validation.test.ts`
Expected: PASS

**Step 5: 提交**

```bash
git add apps/api/src/lib/validation.ts tests/unit/validation.test.ts
git commit -m "feat: add alias validation utilities"
```

---

## Task 2: 重置数据库并添加约束

**Files:**
- Modify: `migrations/001_init.sql`

**Step 1: 更新迁移文件中的表定义**

修改 `migrations/001_init.sql` 中的租户表和项目表：

```sql
-- druvia_tenants 表的 alias 字段
alias VARCHAR(16) NOT NULL CHECK (alias ~ '^[a-z0-9]{3,16}$'),

-- druvia_projects 表的 alias 和 schema_name 字段
alias VARCHAR(16) NOT NULL CHECK (alias ~ '^[a-z0-9]{3,16}$'),
schema_name VARCHAR(35),

-- druvia_schema_registry 表的 schema_name 字段
schema_name VARCHAR(35) NOT NULL,

-- druvia_backups 表的 schema_name 字段
schema_name VARCHAR(35) NOT NULL,
```

**Step 2: 重置数据库**

```bash
cd docker && docker-compose down -v && docker-compose up -d
```

**Step 3: 验证约束生效**

```bash
docker exec druvia-postgres psql -U postgres -d druvia -c "\d druvia_tenants" | grep alias
docker exec druvia-postgres psql -U postgres -d druvia -c "\d druvia_projects" | grep -E "alias|schema"
```

Expected: 看到 varchar(16) 和 CHECK 约束

**Step 4: 提交**

```bash
git add migrations/001_init.sql
git commit -m "feat: add alias length and format constraints"
```

---

## Task 3: 更新租户 Service 添加验证

**Files:**
- Modify: `apps/api/src/modules/tenant/tenant.service.ts`

**Step 1: 添加导入和验证调用**

在文件顶部添加导入：

```typescript
import { validateAlias } from '../../lib/validation.js';
```

在 `createTenant` 函数开头添加验证：

```typescript
export async function createTenant(data: CreateTenantInput): Promise<Tenant> {
  validateAlias(data.alias, '租户别名');
  // ... 现有代码
}
```

**Step 2: 运行集成测试**

Run: `pnpm test tests/integration/tenant.test.ts`
Expected: 部分测试可能因 alias 格式不符而失败

**Step 3: 更新测试用例中的 alias**

修改 `tests/integration/tenant.test.ts` 中所有 alias 为符合规范的格式：

```typescript
// 将类似 test_tenant_xxx 改为 testtenant 或 tenant1
alias: `tenant${Date.now().toString(36).slice(-6)}`,
```

**Step 4: 运行测试确认通过**

Run: `pnpm test tests/integration/tenant.test.ts`
Expected: PASS

**Step 5: 提交**

```bash
git add apps/api/src/modules/tenant/tenant.service.ts tests/integration/tenant.test.ts
git commit -m "feat: add alias validation to tenant service"
```

---

## Task 4: 更新项目 Service 添加验证和新命名

**Files:**
- Modify: `apps/api/src/modules/project/project.service.ts`

**Step 1: 添加导入**

```typescript
import { validateAlias, generateSchemaName } from '../../lib/validation.js';
```

**Step 2: 在 createProject 中添加验证和新命名**

```typescript
export async function createProject(tenantId: string, data: CreateProjectInput): Promise<Project> {
  validateAlias(data.alias, '项目别名');

  // 获取租户 alias
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error('Tenant not found');

  // 使用新的 schema 命名
  const schemaName = generateSchemaName(tenant.alias, data.alias);
  // ... 使用 schemaName 创建 schema
}
```

**Step 3: 更新项目测试用例**

修改 `tests/integration/project.test.ts` 中的 alias 格式。

**Step 4: 运行测试**

Run: `pnpm test tests/integration/project.test.ts`
Expected: PASS

**Step 5: 提交**

```bash
git add apps/api/src/modules/project/project.service.ts tests/integration/project.test.ts
git commit -m "feat: add alias validation and new schema naming to project service"
```

---

## Task 5: 更新前端租户创建页面

**Files:**
- Modify: `apps/admin/src/app/tenants/new/page.tsx`

**Step 1: 更新输入约束和提示**

```tsx
<div>
  <label className="label">别名 (用于 URL)</label>
  <input
    type="text"
    className="input"
    value={form.alias}
    onChange={(e) =>
      setForm({ ...form, alias: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') })
    }
    placeholder="acme"
    pattern="[a-z0-9]{3,16}"
    minLength={3}
    maxLength={16}
    required
  />
  <p className="text-xs text-gray-500 mt-1">
    3-16 个字符，仅限小写字母和数字
  </p>
</div>
```

**Step 2: 手动测试**

打开 http://localhost:3000/tenants/new，验证：
- 输入大写自动转小写
- 输入下划线被过滤
- 少于 3 字符无法提交
- 超过 16 字符被截断

**Step 3: 提交**

```bash
git add apps/admin/src/app/tenants/new/page.tsx
git commit -m "feat: update tenant alias input constraints"
```

---

## Task 6: 更新前端项目创建页面

**Files:**
- Modify: `apps/admin/src/app/t/[tenantId]/projects/new/page.tsx`

**Step 1: 更新输入约束**

```tsx
<div className="space-y-2">
  <label htmlFor="alias" className="text-sm font-medium">
    别名 (用于 URL)
  </label>
  <Input
    id="alias"
    value={form.alias}
    onChange={(e) =>
      setForm({
        ...form,
        alias: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''),
      })
    }
    placeholder="main"
    pattern="[a-z0-9]{3,16}"
    minLength={3}
    maxLength={16}
    required
  />
  <p className="text-xs text-muted-foreground">
    3-16 个字符，仅限小写字母和数字
  </p>
</div>
```

**Step 2: 手动测试**

打开项目创建页面验证输入约束。

**Step 3: 提交**

```bash
git add apps/admin/src/app/t/[tenantId]/projects/new/page.tsx
git commit -m "feat: update project alias input constraints"
```

---

## Task 7: 更新备份页面 Schema 名生成

**Files:**
- Modify: `apps/admin/src/app/backups/page.tsx`

**Step 1: 更新 Schema 名生成逻辑**

```tsx
const handleCreateBackup = async () => {
  if (!selectedTenant || !selectedProject) return;

  const tenant = tenants.find((t) => t.tenantId === selectedTenant);
  const project = projects.find((p) => p.projectId === selectedProject);
  if (!tenant || !project) return;

  setCreating(true);
  try {
    // 使用新的命名格式
    const schemaName = `t_${tenant.alias}_${project.alias}`;
    const res = await api.createBackup(selectedTenant, schemaName);
    // ...
  }
};
```

**Step 2: 提交**

```bash
git add apps/admin/src/app/backups/page.tsx
git commit -m "feat: update backup schema name generation"
```

---

## Task 8: 运行完整测试套件

**Step 1: 运行所有测试**

```bash
pnpm test
```

Expected: 所有测试通过

**Step 2: 手动端到端测试**

1. 创建租户 (alias: `testco`)
2. 创建项目 (alias: `mainapp`)
3. 验证 Schema 名为 `t_testco_mainapp`
4. 创建备份，验证成功

**Step 3: 最终提交**

```bash
git add -A
git commit -m "chore: schema naming convention implementation complete"
```

---

## 验收标准

- [ ] alias 输入限制 3-16 字符
- [ ] alias 仅允许小写字母和数字
- [ ] Schema 名格式为 `t_{tenant}_{project}`
- [ ] 数据库约束生效
- [ ] 前端实时过滤非法字符
- [ ] 所有测试通过
