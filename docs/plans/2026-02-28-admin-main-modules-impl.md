# Admin 主栏目功能实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 Admin 应用五个主栏目的完整功能：用户管理、备份管理、设置模块、仪表板、租户管理

**Architecture:** 分层实现 - 先完成数据库迁移，再实现 API 端点，最后更新前端页面。每个模块独立完成，便于测试和回滚。

**Tech Stack:** PostgreSQL 17, Fastify 5, Next.js 15, React 19, Zustand, shadcn/ui, Recharts (图表)

**设计文档:** `docs/plans/2026-02-28-admin-main-modules-design.md`

---

## Phase 1: 数据库迁移

### Task 1.1: 创建迁移文件 - 用户角色

**Files:**
- Create: `migrations/002_user_roles.sql`

**Step 1: 创建迁移文件**

```sql
-- migrations/002_user_roles.sql
-- Add role column to druvia_users

ALTER TABLE druvia_users
ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'admin';

-- Update existing admin user to super_admin
UPDATE druvia_users
SET role = 'super_admin'
WHERE user_id = 'usr_admin';

-- Add index for role queries
CREATE INDEX IF NOT EXISTS idx_druvia_users_role ON druvia_users(role);

COMMENT ON COLUMN druvia_users.role IS 'User role: super_admin or admin';
```

**Step 2: 执行迁移**

Run: `docker exec -i postgres psql -U druvia -d druvia < migrations/002_user_roles.sql`
Expected: ALTER TABLE, UPDATE, CREATE INDEX 成功

**Step 3: 验证**

Run: `docker exec postgres psql -U druvia -d druvia -c "\d druvia_users"`
Expected: 显示 role 列

---

### Task 1.2: 创建迁移文件 - 租户扩展字段

**Files:**
- Create: `migrations/003_tenant_limits.sql`

**Step 1: 创建迁移文件**

```sql
-- migrations/003_tenant_limits.sql
-- Add description and limit columns to druvia_tenants

ALTER TABLE druvia_tenants
ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE druvia_tenants
ADD COLUMN IF NOT EXISTS storage_limit BIGINT DEFAULT 1073741824;

ALTER TABLE druvia_tenants
ADD COLUMN IF NOT EXISTS project_limit INT DEFAULT 5;

ALTER TABLE druvia_tenants
ADD COLUMN IF NOT EXISTS user_limit INT DEFAULT 10;

COMMENT ON COLUMN druvia_tenants.storage_limit IS 'Storage limit in bytes, default 1GB';
COMMENT ON COLUMN druvia_tenants.project_limit IS 'Max projects per tenant';
COMMENT ON COLUMN druvia_tenants.user_limit IS 'Max users per tenant';
```

**Step 2: 执行迁移**

Run: `docker exec -i postgres psql -U druvia -d druvia < migrations/003_tenant_limits.sql`
Expected: ALTER TABLE 成功

---

### Task 1.3: 创建迁移文件 - 平台设置表

**Files:**
- Create: `migrations/004_settings_table.sql`

**Step 1: 创建迁移文件**

```sql
-- migrations/004_settings_table.sql
-- Platform settings table

CREATE TABLE IF NOT EXISTS druvia_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger for updated_at
CREATE TRIGGER druvia_settings_updated_at
  BEFORE UPDATE ON druvia_settings
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

-- Initial settings
INSERT INTO druvia_settings (key, value) VALUES
  ('default_plan', '"free"'),
  ('default_storage_limit', '1073741824'),
  ('default_project_limit', '5'),
  ('default_user_limit', '10'),
  ('backup_retention_days', '30'),
  ('backup_max_count', '10')
ON CONFLICT (key) DO NOTHING;
```

**Step 2: 执行迁移**

Run: `docker exec -i postgres psql -U druvia -d druvia < migrations/004_settings_table.sql`
Expected: CREATE TABLE, CREATE TRIGGER, INSERT 成功

---

### Task 1.4: 创建迁移文件 - 活动日志表

**Files:**
- Create: `migrations/005_activity_logs.sql`

**Step 1: 创建迁移文件**

```sql
-- migrations/005_activity_logs.sql
-- Activity logs table for dashboard

CREATE TABLE IF NOT EXISTS druvia_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(64) REFERENCES druvia_users(user_id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  target_type VARCHAR(50),
  target_id VARCHAR(100),
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at
ON druvia_activity_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id
ON druvia_activity_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_activity_logs_action
ON druvia_activity_logs(action);

COMMENT ON TABLE druvia_activity_logs IS 'Audit log for admin activities';
```

**Step 2: 执行迁移**

Run: `docker exec -i postgres psql -U druvia -d druvia < migrations/005_activity_logs.sql`
Expected: CREATE TABLE, CREATE INDEX 成功

---

## Phase 2: 共享类型更新

### Task 2.1: 更新 User 类型

**Files:**
- Modify: `packages/shared/src/types/user.ts`

**Step 1: 添加 role 字段到 User 类型**

在 `User` 接口中添加:

```typescript
export type UserRole = 'super_admin' | 'admin';

export interface User {
  id: number;
  userId: string;
  email: string | null;
  username: string | null;
  avatarUrl: string | null;
  status: 'active' | 'inactive' | 'suspended';
  role: UserRole;  // 新增
  createdAt: Date;
  updatedAt: Date;
}
```

**Step 2: 重新构建 shared 包**

Run: `pnpm --filter @druvia/shared build`
Expected: 构建成功

---

### Task 2.2: 添加 Settings 和 ActivityLog 类型

**Files:**
- Create: `packages/shared/src/types/settings.ts`
- Create: `packages/shared/src/types/activity.ts`
- Modify: `packages/shared/src/types/index.ts`

**Step 1: 创建 settings.ts**

```typescript
// packages/shared/src/types/settings.ts
export interface PlatformSettings {
  defaultPlan: string;
  defaultStorageLimit: number;
  defaultProjectLimit: number;
  defaultUserLimit: number;
  backupRetentionDays: number;
  backupMaxCount: number;
}

export type SettingKey = keyof PlatformSettings;
```

**Step 2: 创建 activity.ts**

```typescript
// packages/shared/src/types/activity.ts
export type ActivityAction =
  | 'user.login'
  | 'user.logout'
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'tenant.create'
  | 'tenant.update'
  | 'tenant.delete'
  | 'project.create'
  | 'project.delete'
  | 'backup.create'
  | 'backup.restore'
  | 'backup.delete'
  | 'settings.update';

export interface ActivityLog {
  id: string;
  userId: string | null;
  action: ActivityAction;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}
```

**Step 3: 更新 index.ts 导出**

```typescript
export * from './settings.js';
export * from './activity.js';
```

**Step 4: 重新构建**

Run: `pnpm --filter @druvia/shared build`
Expected: 构建成功

---

## Phase 3: API - 用户管理增强

### Task 3.1: 更新 UserService

**Files:**
- Modify: `apps/api/src/modules/user/user.service.ts`

**Step 1: 更新 UserRow 接口添加 role**

```typescript
interface UserRow {
  id: number;
  user_id: string;
  email: string | null;
  username: string | null;
  password_hash: string | null;
  avatar_url: string | null;
  status: string;
  role: string;  // 新增
  created_at: Date;
  updated_at: Date;
}
```

**Step 2: 更新 toUser 函数**

```typescript
function toUser(row: UserRow): User {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    username: row.username,
    avatarUrl: row.avatar_url,
    status: row.status as User['status'],
    role: row.role as UserRole,  // 新增
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

**Step 3: 添加 createUser 函数**

```typescript
export interface CreateUserInput {
  email: string;
  username: string;
  password: string;
  role: UserRole;
}

export async function createUser(input: CreateUserInput): Promise<User> {
  const userId = generateUserId();
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const row = await queryOne<UserRow>(
    `INSERT INTO druvia_users (user_id, email, username, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, input.email, input.username, passwordHash, input.role]
  );

  if (!row) {
    throw new Error('Failed to create user');
  }

  return toUser(row);
}
```

**Step 4: 添加 updateUserFull 函数**

```typescript
export interface UpdateUserInput {
  username?: string;
  email?: string;
  role?: UserRole;
}

export async function updateUserFull(
  userId: string,
  input: UpdateUserInput
): Promise<User | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.username !== undefined) {
    updates.push(`username = $${paramIndex++}`);
    values.push(input.username);
  }
  if (input.email !== undefined) {
    updates.push(`email = $${paramIndex++}`);
    values.push(input.email);
  }
  if (input.role !== undefined) {
    updates.push(`role = $${paramIndex++}`);
    values.push(input.role);
  }

  if (updates.length === 0) {
    return getUserById(userId);
  }

  values.push(userId);
  const row = await queryOne<UserRow>(
    `UPDATE druvia_users SET ${updates.join(', ')} WHERE user_id = $${paramIndex} RETURNING *`,
    values
  );

  return row ? toUser(row) : null;
}
```

**Step 5: 添加 resetPassword 函数**

```typescript
export async function resetPassword(userId: string): Promise<string> {
  // Generate random 12-char password
  const tempPassword = crypto.randomBytes(9).toString('base64').slice(0, 12);
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  await query(
    'UPDATE druvia_users SET password_hash = $1 WHERE user_id = $2',
    [passwordHash, userId]
  );

  return tempPassword;
}
```

---

### Task 3.2: 更新 UserController

**Files:**
- Modify: `apps/api/src/modules/user/user.controller.ts`

**Step 1: 添加 createUser handler**

```typescript
export async function createUser(
  request: FastifyRequest<{
    Body: { email: string; username: string; password: string; role: UserRole };
  }>,
  reply: FastifyReply
) {
  const currentUser = request.user;
  if (currentUser.role !== 'super_admin') {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only super_admin can create users' },
    });
  }

  const { email, username, password, role } = request.body;

  // Check email uniqueness
  const existing = await userService.getUserByEmail(email);
  if (existing) {
    return reply.status(409).send({
      success: false,
      error: { code: 'CONFLICT', message: 'Email already exists' },
    });
  }

  const user = await userService.createUser({ email, username, password, role });
  return reply.status(201).send({ success: true, data: user });
}
```

**Step 2: 添加 updateUser handler**

```typescript
export async function updateUser(
  request: FastifyRequest<{
    Params: { userId: string };
    Body: { username?: string; email?: string; role?: UserRole };
  }>,
  reply: FastifyReply
) {
  const currentUser = request.user;
  if (currentUser.role !== 'super_admin') {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only super_admin can update users' },
    });
  }

  const { userId } = request.params;
  const user = await userService.updateUserFull(userId, request.body);

  if (!user) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    });
  }

  return reply.send({ success: true, data: user });
}
```

**Step 3: 添加 resetPassword handler**

```typescript
export async function resetPassword(
  request: FastifyRequest<{ Params: { userId: string } }>,
  reply: FastifyReply
) {
  const currentUser = request.user;
  if (currentUser.role !== 'super_admin') {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only super_admin can reset passwords' },
    });
  }

  const { userId } = request.params;

  // Cannot reset own password via this endpoint
  if (userId === currentUser.userId) {
    return reply.status(400).send({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Use /users/me/password to change your own password' },
    });
  }

  const tempPassword = await userService.resetPassword(userId);
  return reply.send({ success: true, data: { tempPassword } });
}
```

**Step 4: 更新 deleteUser 添加自我保护**

```typescript
export async function deleteUser(
  request: FastifyRequest<{ Params: { userId: string } }>,
  reply: FastifyReply
) {
  const currentUser = request.user;
  if (currentUser.role !== 'super_admin') {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only super_admin can delete users' },
    });
  }

  const { userId } = request.params;

  // Cannot delete self
  if (userId === currentUser.userId) {
    return reply.status(400).send({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Cannot delete yourself' },
    });
  }

  const deleted = await userService.deleteUser(userId);
  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'User not found' },
    });
  }

  return reply.send({ success: true, data: { deleted: true } });
}
```

---

### Task 3.3: 更新 UserRoutes

**Files:**
- Modify: `apps/api/src/modules/user/user.routes.ts`

**Step 1: 添加新路由**

```typescript
// Admin routes (user management)
app.post('/users', { preHandler: authenticate }, controller.createUser as never);
app.get('/users', { preHandler: authenticate }, controller.listUsers);
app.get('/users/:userId', { preHandler: authenticate }, controller.getUser as never);
app.patch('/users/:userId', { preHandler: authenticate }, controller.updateUser as never);
app.delete('/users/:userId', { preHandler: authenticate }, controller.deleteUser as never);
app.patch('/users/:userId/status', { preHandler: authenticate }, controller.updateUserStatus as never);
app.post('/users/:userId/reset-password', { preHandler: authenticate }, controller.resetPassword as never);
```

---

## Phase 4: API - 设置模块

### Task 4.1: 创建 SettingsService

**Files:**
- Create: `apps/api/src/modules/settings/settings.service.ts`

**Step 1: 创建 service 文件**

```typescript
// apps/api/src/modules/settings/settings.service.ts
import { query, queryOne } from '../../db/index.js';
import type { PlatformSettings } from '@druvia/shared';

interface SettingRow {
  key: string;
  value: unknown;
  updated_at: Date;
}

const SETTING_KEYS: (keyof PlatformSettings)[] = [
  'defaultPlan',
  'defaultStorageLimit',
  'defaultProjectLimit',
  'defaultUserLimit',
  'backupRetentionDays',
  'backupMaxCount',
];

// Convert camelCase to snake_case for DB
function toDbKey(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

// Convert snake_case to camelCase
function toCamelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export async function getSettings(): Promise<PlatformSettings> {
  const rows = await query<SettingRow>('SELECT * FROM druvia_settings');

  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    const camelKey = toCamelCase(row.key);
    settings[camelKey] = row.value;
  }

  return settings as PlatformSettings;
}

export async function getSetting<K extends keyof PlatformSettings>(
  key: K
): Promise<PlatformSettings[K] | null> {
  const dbKey = toDbKey(key);
  const row = await queryOne<SettingRow>(
    'SELECT * FROM druvia_settings WHERE key = $1',
    [dbKey]
  );
  return row ? (row.value as PlatformSettings[K]) : null;
}

export async function updateSettings(
  updates: Partial<PlatformSettings>
): Promise<PlatformSettings> {
  for (const [key, value] of Object.entries(updates)) {
    if (!SETTING_KEYS.includes(key as keyof PlatformSettings)) continue;

    const dbKey = toDbKey(key);
    await query(
      `INSERT INTO druvia_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [dbKey, JSON.stringify(value)]
    );
  }

  return getSettings();
}
```

---

### Task 4.2: 创建 SettingsController

**Files:**
- Create: `apps/api/src/modules/settings/settings.controller.ts`

**Step 1: 创建 controller 文件**

```typescript
// apps/api/src/modules/settings/settings.controller.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import * as settingsService from './settings.service.js';
import type { PlatformSettings } from '@druvia/shared';

export async function getSettings(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const settings = await settingsService.getSettings();
  return reply.send({ success: true, data: settings });
}

export async function updateSettings(
  request: FastifyRequest<{ Body: Partial<PlatformSettings> }>,
  reply: FastifyReply
) {
  const currentUser = request.user;
  if (currentUser.role !== 'super_admin') {
    return reply.status(403).send({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Only super_admin can update settings' },
    });
  }

  const settings = await settingsService.updateSettings(request.body);
  return reply.send({ success: true, data: settings });
}
```

---

### Task 4.3: 创建 SettingsRoutes

**Files:**
- Create: `apps/api/src/modules/settings/settings.routes.ts`

**Step 1: 创建 routes 文件**

```typescript
// apps/api/src/modules/settings/settings.routes.ts
import type { FastifyInstance } from 'fastify';
import * as controller from './settings.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', { preHandler: authenticate }, controller.getSettings);
  app.patch('/settings', { preHandler: authenticate }, controller.updateSettings as never);
}
```

**Step 2: 注册路由到 app.ts**

在 `apps/api/src/app.ts` 中添加:

```typescript
import { settingsRoutes } from './modules/settings/settings.routes.js';

// 在路由注册部分添加
app.register(settingsRoutes, { prefix: '/api/v1' });
```

---

## Phase 5: API - 活动日志

### Task 5.1: 创建 ActivityService

**Files:**
- Create: `apps/api/src/modules/activity/activity.service.ts`

**Step 1: 创建 service 文件**

```typescript
// apps/api/src/modules/activity/activity.service.ts
import { query, queryOne } from '../../db/index.js';
import type { ActivityLog, ActivityAction } from '@druvia/shared';

interface ActivityRow {
  id: string;
  user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: Date;
}

function toActivityLog(row: ActivityRow): ActivityLog {
  return {
    id: row.id,
    userId: row.user_id,
    action: row.action as ActivityAction,
    targetType: row.target_type,
    targetId: row.target_id,
    details: row.details,
    createdAt: row.created_at,
  };
}

export async function logActivity(
  userId: string | null,
  action: ActivityAction,
  targetType?: string,
  targetId?: string,
  details?: Record<string, unknown>
): Promise<ActivityLog> {
  const row = await queryOne<ActivityRow>(
    `INSERT INTO druvia_activity_logs (user_id, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, action, targetType || null, targetId || null, details ? JSON.stringify(details) : null]
  );

  if (!row) throw new Error('Failed to create activity log');
  return toActivityLog(row);
}

export async function listActivities(
  limit = 20,
  offset = 0
): Promise<{ activities: ActivityLog[]; total: number }> {
  const rows = await query<ActivityRow>(
    `SELECT * FROM druvia_activity_logs
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const countResult = await queryOne<{ count: string }>(
    'SELECT COUNT(*) as count FROM druvia_activity_logs'
  );
  const total = parseInt(countResult?.count || '0', 10);

  return {
    activities: rows.map(toActivityLog),
    total,
  };
}
```

---

## Phase 6: API - 仪表板

### Task 6.1: 创建 DashboardService

**Files:**
- Create: `apps/api/src/modules/dashboard/dashboard.service.ts`

**Step 1: 创建 service 文件**

```typescript
// apps/api/src/modules/dashboard/dashboard.service.ts
import { query, queryOne } from '../../db/index.js';

export interface DashboardStats {
  tenants: { total: number; weekNew: number };
  users: { total: number; weekNew: number };
  backups: { total: number; weekNew: number };
  storage: { used: number; total: number };
}

export interface TrendData {
  date: string;
  tenants: number;
  users: number;
  backups: number;
}

export interface ResourceUsage {
  topTenants: { name: string; size: number }[];
  storageByTenant: { name: string; size: number }[];
}

export async function getStats(): Promise<DashboardStats> {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [tenantTotal, tenantWeek] = await Promise.all([
    queryOne<{ count: string }>('SELECT COUNT(*) as count FROM druvia_tenants'),
    queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM druvia_tenants WHERE created_at >= $1',
      [weekAgo]
    ),
  ]);

  const [userTotal, userWeek] = await Promise.all([
    queryOne<{ count: string }>('SELECT COUNT(*) as count FROM druvia_users'),
    queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM druvia_users WHERE created_at >= $1',
      [weekAgo]
    ),
  ]);

  const [backupTotal, backupWeek] = await Promise.all([
    queryOne<{ count: string }>('SELECT COUNT(*) as count FROM druvia_backups'),
    queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM druvia_backups WHERE created_at >= $1',
      [weekAgo]
    ),
  ]);

  const storageUsed = await queryOne<{ total: string }>(
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM druvia_backups'
  );

  const storageLimit = await queryOne<{ total: string }>(
    'SELECT COALESCE(SUM(storage_limit), 0) as total FROM druvia_tenants'
  );

  return {
    tenants: {
      total: parseInt(tenantTotal?.count || '0', 10),
      weekNew: parseInt(tenantWeek?.count || '0', 10),
    },
    users: {
      total: parseInt(userTotal?.count || '0', 10),
      weekNew: parseInt(userWeek?.count || '0', 10),
    },
    backups: {
      total: parseInt(backupTotal?.count || '0', 10),
      weekNew: parseInt(backupWeek?.count || '0', 10),
    },
    storage: {
      used: parseInt(storageUsed?.total || '0', 10),
      total: parseInt(storageLimit?.total || '0', 10),
    },
  };
}

export async function getTrends(days = 7): Promise<TrendData[]> {
  const results: TrendData[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);

    const [tenants, users, backups] = await Promise.all([
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM druvia_tenants
         WHERE created_at >= $1 AND created_at < $2`,
        [date, nextDate]
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM druvia_users
         WHERE created_at >= $1 AND created_at < $2`,
        [date, nextDate]
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM druvia_backups
         WHERE created_at >= $1 AND created_at < $2`,
        [date, nextDate]
      ),
    ]);

    results.push({
      date: dateStr,
      tenants: parseInt(tenants?.count || '0', 10),
      users: parseInt(users?.count || '0', 10),
      backups: parseInt(backups?.count || '0', 10),
    });
  }

  return results;
}

export async function getResourceUsage(): Promise<ResourceUsage> {
  const topTenants = await query<{ name: string; size: string }>(
    `SELECT t.name, COALESCE(SUM(sr.size_bytes), 0) as size
     FROM druvia_tenants t
     LEFT JOIN druvia_schema_registry sr ON t.tenant_id = sr.tenant_id
     GROUP BY t.tenant_id, t.name
     ORDER BY size DESC
     LIMIT 5`
  );

  const storageByTenant = await query<{ name: string; size: string }>(
    `SELECT t.name, COALESCE(SUM(b.size_bytes), 0) as size
     FROM druvia_tenants t
     LEFT JOIN druvia_backups b ON t.tenant_id = b.tenant_id
     GROUP BY t.tenant_id, t.name
     ORDER BY size DESC
     LIMIT 10`
  );

  return {
    topTenants: topTenants.map((r) => ({ name: r.name, size: parseInt(r.size, 10) })),
    storageByTenant: storageByTenant.map((r) => ({ name: r.name, size: parseInt(r.size, 10) })),
  };
}
```

---

### Task 6.2: 创建 DashboardController 和 Routes

**Files:**
- Create: `apps/api/src/modules/dashboard/dashboard.controller.ts`
- Create: `apps/api/src/modules/dashboard/dashboard.routes.ts`

**Step 1: 创建 controller**

```typescript
// apps/api/src/modules/dashboard/dashboard.controller.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import * as dashboardService from './dashboard.service.js';
import * as activityService from '../activity/activity.service.js';

export async function getStats(request: FastifyRequest, reply: FastifyReply) {
  const stats = await dashboardService.getStats();
  return reply.send({ success: true, data: stats });
}

export async function getTrends(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply
) {
  const days = parseInt(request.query.days || '7', 10);
  const trends = await dashboardService.getTrends(days);
  return reply.send({ success: true, data: trends });
}

export async function getActivities(
  request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply
) {
  const limit = parseInt(request.query.limit || '20', 10);
  const offset = parseInt(request.query.offset || '0', 10);
  const result = await activityService.listActivities(limit, offset);
  return reply.send({ success: true, data: result });
}

export async function getResources(request: FastifyRequest, reply: FastifyReply) {
  const resources = await dashboardService.getResourceUsage();
  return reply.send({ success: true, data: resources });
}
```

**Step 2: 创建 routes**

```typescript
// apps/api/src/modules/dashboard/dashboard.routes.ts
import type { FastifyInstance } from 'fastify';
import * as controller from './dashboard.controller.js';
import { authenticate } from '../../middleware/auth.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard/stats', { preHandler: authenticate }, controller.getStats);
  app.get('/dashboard/trends', { preHandler: authenticate }, controller.getTrends as never);
  app.get('/dashboard/activities', { preHandler: authenticate }, controller.getActivities as never);
  app.get('/dashboard/resources', { preHandler: authenticate }, controller.getResources);
}
```

**Step 3: 注册路由**

在 `apps/api/src/app.ts` 中添加:

```typescript
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';

app.register(dashboardRoutes, { prefix: '/api/v1' });
```

---

## Phase 7: API - 备份管理增强

### Task 7.1: 更新 BackupService

**Files:**
- Modify: `apps/api/src/modules/backup/backup.service.ts`

**Step 1: 添加 deleteBackup 函数**

```typescript
export async function deleteBackup(backupId: string): Promise<boolean> {
  // Get backup info first
  const backup = await getBackupById(backupId);
  if (!backup) return false;

  // Delete from storage
  const storage = createStorageAdapter();
  await storage.delete(backup.storageKey);

  // Delete from database
  const rows = await query<{ backup_id: string }>(
    'DELETE FROM druvia_backups WHERE backup_id = $1 RETURNING backup_id',
    [backupId]
  );

  return rows.length > 0;
}
```

**Step 2: 添加 getBackupDownloadUrl 函数**

```typescript
export async function getBackupDownloadUrl(backupId: string): Promise<string | null> {
  const backup = await getBackupById(backupId);
  if (!backup) return null;

  const storage = createStorageAdapter();
  return storage.getSignedUrl(backup.storageKey, 3600); // 1 hour expiry
}
```

**Step 3: 添加 restoreBackup 函数**

```typescript
export async function restoreBackup(backupId: string): Promise<boolean> {
  const backup = await getBackupById(backupId);
  if (!backup || backup.status !== 'completed') return false;

  const storage = createStorageAdapter();
  const sqlContent = await storage.download(backup.storageKey);

  // Execute restore in transaction
  await query('BEGIN');
  try {
    // Drop existing tables in schema
    await query(`DROP SCHEMA IF EXISTS ${backup.schemaName} CASCADE`);
    await query(`CREATE SCHEMA ${backup.schemaName}`);

    // Execute backup SQL
    await query(sqlContent.toString());

    await query('COMMIT');
    return true;
  } catch (error) {
    await query('ROLLBACK');
    throw error;
  }
}
```

**Step 4: 添加 listAllBackups 函数 (支持全部租户筛选)**

```typescript
export async function listAllBackups(
  tenantId?: string,
  projectId?: string,
  limit = 50,
  offset = 0
): Promise<{ backups: Backup[]; total: number }> {
  let whereClause = '';
  const params: unknown[] = [];
  let paramIndex = 1;

  if (tenantId) {
    whereClause = `WHERE tenant_id = $${paramIndex++}`;
    params.push(tenantId);
  }
  if (projectId) {
    whereClause += whereClause ? ` AND project_id = $${paramIndex++}` : `WHERE project_id = $${paramIndex++}`;
    params.push(projectId);
  }

  params.push(limit, offset);

  const rows = await query<BackupRow>(
    `SELECT b.*, t.name as tenant_name, p.name as project_name
     FROM druvia_backups b
     LEFT JOIN druvia_tenants t ON b.tenant_id = t.tenant_id
     LEFT JOIN druvia_projects p ON b.project_id = p.project_id
     ${whereClause}
     ORDER BY b.created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  const countParams = params.slice(0, -2);
  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM druvia_backups ${whereClause}`,
    countParams
  );

  return {
    backups: rows.map(toBackup),
    total: parseInt(countResult?.count || '0', 10),
  };
}
```

---

### Task 7.2: 更新 BackupController

**Files:**
- Modify: `apps/api/src/modules/backup/backup.controller.ts`

**Step 1: 添加 downloadBackup handler**

```typescript
export async function downloadBackup(
  request: FastifyRequest<{ Params: { backupId: string } }>,
  reply: FastifyReply
) {
  const { backupId } = request.params;
  const url = await backupService.getBackupDownloadUrl(backupId);

  if (!url) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Backup not found' },
    });
  }

  return reply.send({ success: true, data: { downloadUrl: url } });
}
```

**Step 2: 添加 restoreBackup handler**

```typescript
export async function restoreBackup(
  request: FastifyRequest<{ Params: { backupId: string } }>,
  reply: FastifyReply
) {
  const { backupId } = request.params;

  try {
    const restored = await backupService.restoreBackup(backupId);
    if (!restored) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Backup not found or not completed' },
      });
    }

    // Log activity
    await activityService.logActivity(
      request.user.userId,
      'backup.restore',
      'backup',
      backupId
    );

    return reply.send({ success: true, data: { restored: true } });
  } catch (error) {
    return reply.status(500).send({
      success: false,
      error: { code: 'RESTORE_FAILED', message: 'Failed to restore backup' },
    });
  }
}
```

**Step 3: 添加 deleteBackup handler**

```typescript
export async function deleteBackup(
  request: FastifyRequest<{ Params: { backupId: string } }>,
  reply: FastifyReply
) {
  const { backupId } = request.params;
  const deleted = await backupService.deleteBackup(backupId);

  if (!deleted) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Backup not found' },
    });
  }

  // Log activity
  await activityService.logActivity(
    request.user.userId,
    'backup.delete',
    'backup',
    backupId
  );

  return reply.send({ success: true, data: { deleted: true } });
}
```

**Step 4: 添加 listAllBackups handler**

```typescript
export async function listAllBackups(
  request: FastifyRequest<{
    Querystring: { tenantId?: string; projectId?: string; limit?: string; offset?: string };
  }>,
  reply: FastifyReply
) {
  const { tenantId, projectId, limit, offset } = request.query;
  const result = await backupService.listAllBackups(
    tenantId || undefined,
    projectId || undefined,
    parseInt(limit || '50', 10),
    parseInt(offset || '0', 10)
  );

  return reply.send({ success: true, data: result });
}
```

---

### Task 7.3: 更新 BackupRoutes

**Files:**
- Modify: `apps/api/src/modules/backup/backup.routes.ts`

**Step 1: 添加新路由**

```typescript
// Global backup routes (for admin)
app.get('/backups', { preHandler: authenticate }, controller.listAllBackups as never);
app.get('/backups/:backupId/download', { preHandler: authenticate }, controller.downloadBackup as never);
app.post('/backups/:backupId/restore', { preHandler: authenticate }, controller.restoreBackup as never);
app.delete('/backups/:backupId', { preHandler: authenticate }, controller.deleteBackup as never);
```

---

## Phase 8: API - 租户管理增强

### Task 8.1: 更新 TenantService

**Files:**
- Modify: `apps/api/src/modules/tenant/tenant.service.ts`

**Step 1: 添加 updateTenant 函数**

```typescript
export interface UpdateTenantInput {
  name?: string;
  description?: string;
  plan?: string;
  status?: 'active' | 'inactive';
  storageLimit?: number;
  projectLimit?: number;
  userLimit?: number;
}

export async function updateTenant(
  tenantId: string,
  input: UpdateTenantInput
): Promise<Tenant | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(input.name);
  }
  if (input.description !== undefined) {
    updates.push(`description = $${paramIndex++}`);
    values.push(input.description);
  }
  if (input.plan !== undefined) {
    updates.push(`plan = $${paramIndex++}`);
    values.push(input.plan);
  }
  if (input.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(input.status);
  }
  if (input.storageLimit !== undefined) {
    updates.push(`storage_limit = $${paramIndex++}`);
    values.push(input.storageLimit);
  }
  if (input.projectLimit !== undefined) {
    updates.push(`project_limit = $${paramIndex++}`);
    values.push(input.projectLimit);
  }
  if (input.userLimit !== undefined) {
    updates.push(`user_limit = $${paramIndex++}`);
    values.push(input.userLimit);
  }

  if (updates.length === 0) {
    return getTenantById(tenantId);
  }

  values.push(tenantId);
  const row = await queryOne<TenantRow>(
    `UPDATE druvia_tenants SET ${updates.join(', ')} WHERE tenant_id = $${paramIndex} RETURNING *`,
    values
  );

  return row ? toTenant(row) : null;
}
```

**Step 2: 更新 TenantRow 和 toTenant 添加新字段**

```typescript
interface TenantRow {
  // ... existing fields
  description: string | null;
  storage_limit: number;
  project_limit: number;
  user_limit: number;
}

function toTenant(row: TenantRow): Tenant {
  return {
    // ... existing fields
    description: row.description,
    storageLimit: row.storage_limit,
    projectLimit: row.project_limit,
    userLimit: row.user_limit,
  };
}
```

---

### Task 8.2: 更新 TenantController

**Files:**
- Modify: `apps/api/src/modules/tenant/tenant.controller.ts`

**Step 1: 添加 updateTenant handler**

```typescript
export async function updateTenant(
  request: FastifyRequest<{
    Params: { tenantId: string };
    Body: UpdateTenantInput;
  }>,
  reply: FastifyReply
) {
  const { tenantId } = request.params;
  const tenant = await tenantService.updateTenant(tenantId, request.body);

  if (!tenant) {
    return reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Tenant not found' },
    });
  }

  // Log activity
  await activityService.logActivity(
    request.user.userId,
    'tenant.update',
    'tenant',
    tenantId,
    request.body
  );

  return reply.send({ success: true, data: tenant });
}
```

---

### Task 8.3: 更新 TenantRoutes

**Files:**
- Modify: `apps/api/src/modules/tenant/tenant.routes.ts`

**Step 1: 添加 PATCH 路由**

```typescript
app.patch('/tenants/:tenantId', { preHandler: authenticate }, controller.updateTenant as never);
```

---

## Phase 9: 前端 - Admin 页面更新

### Task 9.1: 更新 API Client

**Files:**
- Modify: `apps/admin/src/lib/api.ts`

**Step 1: 添加新 API 方法**

```typescript
// User management
async createUser(data: { email: string; username: string; password: string; role: string }) {
  return this.request<User>('/users', { method: 'POST', body: JSON.stringify(data) });
}

async updateUser(userId: string, data: { username?: string; email?: string; role?: string }) {
  return this.request<User>(`/users/${userId}`, { method: 'PATCH', body: JSON.stringify(data) });
}

async resetUserPassword(userId: string) {
  return this.request<{ tempPassword: string }>(`/users/${userId}/reset-password`, { method: 'POST' });
}

// Settings
async getSettings() {
  return this.request<PlatformSettings>('/settings');
}

async updateSettings(data: Partial<PlatformSettings>) {
  return this.request<PlatformSettings>('/settings', { method: 'PATCH', body: JSON.stringify(data) });
}

async updateProfile(data: { username?: string; email?: string }) {
  return this.request<User>('/users/me', { method: 'PATCH', body: JSON.stringify(data) });
}

async changePassword(data: { oldPassword: string; newPassword: string }) {
  return this.request<{ success: boolean }>('/users/me/password', { method: 'POST', body: JSON.stringify(data) });
}

// Dashboard
async getDashboardStats() {
  return this.request<DashboardStats>('/dashboard/stats');
}

async getDashboardTrends(days = 7) {
  return this.request<TrendData[]>(`/dashboard/trends?days=${days}`);
}

async getDashboardActivities(limit = 20, offset = 0) {
  return this.request<{ activities: ActivityLog[]; total: number }>(`/dashboard/activities?limit=${limit}&offset=${offset}`);
}

async getDashboardResources() {
  return this.request<ResourceUsage>('/dashboard/resources');
}

// Backups (global)
async listAllBackups(tenantId?: string, projectId?: string, limit = 50, offset = 0) {
  const params = new URLSearchParams();
  if (tenantId) params.set('tenantId', tenantId);
  if (projectId) params.set('projectId', projectId);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return this.request<{ backups: Backup[]; total: number }>(`/backups?${params}`);
}

async downloadBackup(backupId: string) {
  return this.request<{ downloadUrl: string }>(`/backups/${backupId}/download`);
}

async restoreBackup(backupId: string) {
  return this.request<{ restored: boolean }>(`/backups/${backupId}/restore`, { method: 'POST' });
}

async deleteBackup(backupId: string) {
  return this.request<{ deleted: boolean }>(`/backups/${backupId}`, { method: 'DELETE' });
}

// Tenant update
async updateTenant(tenantId: string, data: UpdateTenantInput) {
  return this.request<Tenant>(`/tenants/${tenantId}`, { method: 'PATCH', body: JSON.stringify(data) });
}
```

---

### Task 9.2: 更新用户管理页面

**Files:**
- Modify: `apps/admin/src/app/users/page.tsx`

**关键变更:**
1. 添加"角色"列显示
2. 添加"添加用户"按钮和对话框
3. 添加"编辑用户"对话框
4. 添加"重置密码"功能
5. 禁用对自己的禁用/删除操作
6. 根据当前用户角色显示/隐藏操作按钮

---

### Task 9.3: 更新备份管理页面

**Files:**
- Modify: `apps/admin/src/app/backups/page.tsx`

**关键变更:**
1. 租户选择器添加"全部租户"选项
2. 项目选择器添加"全部项目"选项
3. 列表添加"租户"和"项目"列
4. 实现下载、恢复、删除功能
5. 添加确认对话框

---

### Task 9.4: 更新设置页面

**Files:**
- Modify: `apps/admin/src/app/settings/page.tsx`

**关键变更:**
1. 账户设置区域：用户名、邮箱可编辑，修改密码功能
2. 平台配置区域（仅超级管理员可见）：默认套餐、配额、备份设置
3. 系统信息区域：只读展示

---

### Task 9.5: 更新仪表板页面

**Files:**
- Modify: `apps/admin/src/app/dashboard/page.tsx`

**关键变更:**
1. 统计卡片：显示真实数据和本周新增
2. 趋势图表：使用 Recharts 显示近7天数据
3. 活动日志：显示最近操作
4. 系统状态：保持现有
5. 资源使用：存储分布饼图、Top 5 租户

**依赖安装:**
Run: `pnpm --filter admin add recharts`

---

### Task 9.6: 更新租户管理页面

**Files:**
- Modify: `apps/admin/src/app/tenants/page.tsx`

**关键变更:**
1. 列表添加：项目数、存储用量列
2. 添加"编辑租户"对话框（三个 Tab）
3. 状态切换确认对话框
4. 删除确认需输入别名

---

## 执行顺序总结

1. **Phase 1**: 数据库迁移 (Task 1.1 - 1.4)
2. **Phase 2**: 共享类型更新 (Task 2.1 - 2.2)
3. **Phase 3**: 用户管理 API (Task 3.1 - 3.3)
4. **Phase 4**: 设置模块 API (Task 4.1 - 4.3)
5. **Phase 5**: 活动日志 API (Task 5.1)
6. **Phase 6**: 仪表板 API (Task 6.1 - 6.2)
7. **Phase 7**: 备份管理 API (Task 7.1 - 7.3)
8. **Phase 8**: 租户管理 API (Task 8.1 - 8.3)
9. **Phase 9**: 前端页面更新 (Task 9.1 - 9.6)

---

## 测试检查点

每个 Phase 完成后运行:

```bash
# API 测试
pnpm --filter api test

# 类型检查
pnpm --filter @druvia/shared build
pnpm --filter api typecheck
pnpm --filter admin typecheck

# 启动验证
pnpm dev
```
