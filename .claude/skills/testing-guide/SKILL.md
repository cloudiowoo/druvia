---
name: testing-guide
description: This skill should be used when the user asks about "testing", "vitest", "unit tests", "integration tests", "test setup", "test fixtures", or mentions "TDD", "test database", "test isolation".
---

# Testing Guide

Druvia 平台测试开发指南。

## 测试结构

```
tests/
├── setup.ts              # 环境变量配置 (在 import 之前执行)
├── unit/                 # 单元测试
│   ├── id.test.ts
│   └── auth.test.ts
├── integration/          # 集成测试 (需要数据库)
│   ├── tenant.test.ts
│   ├── user.test.ts
│   └── project.test.ts
├── e2e/                  # 端到端测试
└── fixtures/             # 测试数据
```

## 重要规则

### 环境变量设置

环境变量必须在 `tests/setup.ts` 中设置，且在任何 import 之前：

```typescript
// tests/setup.ts
// ✅ 正确: 在文件顶部，import 之前
process.env.JWT_SECRET = 'test-secret-key-for-testing-only-32chars';
process.env.DB_HOST = 'localhost';
process.env.POSTGRES_PASSWORD = 'druvia_dev_password';

// 然后才能 import 其他模块
```

### 数据库连接池

**不要**在每个测试文件的 `afterAll` 中调用 `pool.end()`：

```typescript
// ✅ 正确: 不关闭 pool，由 vitest 统一管理
afterAll(async () => {
  await pool.query('DELETE FROM druvia_tenants WHERE alias LIKE $1', ['test_%']);
});

// ❌ 错误: 会导致其他测试文件连接失败
afterAll(async () => {
  await pool.query('DELETE FROM ...');
  await pool.end();  // 不要这样做！
});
```

### 测试数据隔离

使用唯一前缀避免测试间冲突：

```typescript
// ✅ 正确: 使用唯一前缀
beforeAll(async () => {
  await tenantService.createTenant({
    alias: 'test_acme',      // test_ 前缀
    name: 'Test Tenant',
    ownerUid: testUserId,
  });
});

afterAll(async () => {
  // 只清理带前缀的测试数据
  await pool.query('DELETE FROM druvia_tenants WHERE alias LIKE $1', ['test_%']);
});
```

不同测试文件使用不同前缀：
- `tenant.test.ts` → `test_`
- `project.test.ts` → `proj_`
- `user.test.ts` → `@test-user.com`

### 清理残留数据

在 `beforeAll` 中先清理可能残留的测试数据：

```typescript
beforeAll(async () => {
  // 先清理残留数据
  await pool.query('DELETE FROM druvia_tenants WHERE alias = $1', ['test_tenant']);
  await pool.query('DELETE FROM druvia_users WHERE user_id = $1', ['user_test']);

  // 再创建测试数据
  const user = await createTestUser();
});
```

## 运行测试

```bash
# 运行所有测试
pnpm test

# 监听模式
pnpm test:watch

# 带覆盖率
pnpm test:coverage

# 运行单个文件
pnpm test tests/integration/tenant.test.ts
```

## Vitest 配置

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],  // 重要: 环境变量配置
  },
});
```
