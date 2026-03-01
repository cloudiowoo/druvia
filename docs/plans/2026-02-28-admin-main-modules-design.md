# Admin 应用主栏目功能设计

**日期**: 2026-02-28
**状态**: 已批准
**范围**: Dashboard / Tenants / Users / Backups / Settings 五个主栏目

---

## 1. 用户管理 (Users)

### 1.1 角色体系

| 角色 | 标识 | 权限范围 |
|------|------|----------|
| 超级管理员 | `super_admin` | 全部权限，可管理其他管理员 |
| 普通管理员 | `admin` | 管理租户/备份等，不可管理管理员 |

### 1.2 功能矩阵

| 功能 | 超级管理员 | 普通管理员 | 约束 |
|------|:----------:|:----------:|------|
| 查看用户列表 | ✅ | ✅ | 显示角色标签 |
| 添加用户 | ✅ | ❌ | 指定角色、初始密码 |
| 编辑用户 | ✅ | ❌ | 修改用户名、邮箱、角色 |
| 禁用/启用用户 | ✅ | ❌ | 不可操作自己 |
| 删除用户 | ✅ | ❌ | 不可删除自己，需二次确认 |
| 重置密码 | ✅ | ❌ | 生成临时密码 |

### 1.3 UI 变更

- 用户列表增加"角色"列
- 操作按钮根据当前用户权限动态显示/隐藏
- 自己的行禁用"禁用"和"删除"按钮
- 新增"添加用户"对话框（用户名、邮箱、角色、初始密码）

### 1.4 数据库变更

```sql
ALTER TABLE druvia_users ADD COLUMN role VARCHAR(20) DEFAULT 'admin';
-- 可选值: 'super_admin', 'admin'
```

---

## 2. 备份管理 (Backups)

### 2.1 筛选体验优化

- 租户选择器增加"全部租户"选项（默认选中）
- 项目选择器增加"全部项目"选项
- 选择"全部租户"时，项目选择器显示"全部项目"且禁用
- 列表增加"租户"和"项目"列

### 2.2 功能清单

| 功能 | 当前状态 | 目标状态 | 说明 |
|------|----------|----------|------|
| 查看备份列表 | ✅ 已实现 | 增强 | 增加租户/项目列 |
| 创建备份 | ✅ 已实现 | 保持 | - |
| 下载备份 | ❌ 未实现 | 实现 | 下载 SQL 文件 |
| 恢复备份 | ❌ 未实现 | 实现 | 需二次确认 |
| 删除备份 | ❌ 未实现 | 实现 | 需输入 ID 确认 |

### 2.3 列表展示

```
| 租户 | 项目 | Schema | 状态 | 大小 | 表数量 | 创建时间 | 操作 |
```

### 2.4 交互细节

- 恢复备份前显示警告："此操作将覆盖当前数据，是否继续？"
- 删除备份需输入备份 ID 确认（防误删）
- 下载时显示进度提示

---

## 3. 设置模块 (Settings)

### 3.1 账户设置

| 配置项 | 类型 | 权限 |
|--------|------|------|
| 用户名 | 可编辑 | 所有管理员 |
| 邮箱 | 可编辑 | 所有管理员 |
| 修改密码 | 操作 | 所有管理员 |

### 3.2 平台默认配置

| 配置项 | 类型 | 默认值 | 权限 |
|--------|------|--------|------|
| 默认套餐 | 下拉选择 | free | 超级管理员 |
| 默认存储配额 | 数字 (MB) | 1024 | 超级管理员 |
| 默认项目数限制 | 数字 | 5 | 超级管理员 |
| 默认用户数限制 | 数字 | 10 | 超级管理员 |
| 备份保留天数 | 数字 | 30 | 超级管理员 |
| 备份最大数量 | 数字 | 10 | 超级管理员 |

### 3.3 系统信息（只读）

- API 地址
- Hasura 地址
- 系统版本
- 数据库版本

### 3.4 数据库变更

```sql
CREATE TABLE druvia_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 初始数据
INSERT INTO druvia_settings (key, value) VALUES
  ('default_plan', '"free"'),
  ('default_storage_limit', '1073741824'),
  ('default_project_limit', '5'),
  ('default_user_limit', '10'),
  ('backup_retention_days', '30'),
  ('backup_max_count', '10');
```

---

## 4. 仪表板 (Dashboard)

### 4.1 布局结构

```
┌─────────────────────────────────────────────────────────────┐
│  统计卡片区（4列）                                            │
│  租户总数 | 用户总数 | 备份总数 | 存储用量                     │
├─────────────────────────────────────────────────────────────┤
│  趋势图表区（2列）                                            │
│  近7天新增租户/用户 | 近7天备份/存储                           │
├─────────────────────────────────────────────────────────────┤
│  详情区（2列）                                                │
│  最近活动日志 | 系统状态                                       │
├─────────────────────────────────────────────────────────────┤
│  资源使用区（3列）                                            │
│  存储用量分布 | 数据库大小 Top5 | API 调用量                   │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 统计卡片

| 指标 | 数据来源 | 附加信息 |
|------|----------|----------|
| 租户总数 | `druvia_tenants` | 本周新增数 |
| 用户总数 | `druvia_users` | 本周新增数 |
| 备份总数 | `druvia_backups` | 本周新增数 |
| 存储用量 | 聚合计算 | 总配额占比 |

### 4.3 活动日志

记录以下操作类型：
- 用户登录/登出
- 租户创建/删除/修改
- 项目创建/删除
- 备份创建/恢复/删除
- 设置变更

### 4.4 数据库变更

```sql
CREATE TABLE druvia_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES druvia_users(uid),
  action VARCHAR(50) NOT NULL,
  target_type VARCHAR(50),
  target_id VARCHAR(100),
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_activity_logs_created_at ON druvia_activity_logs(created_at DESC);
CREATE INDEX idx_activity_logs_user_id ON druvia_activity_logs(user_id);
```

---

## 5. 租户管理 (Tenants)

### 5.1 列表增强

| 列 | 说明 |
|----|------|
| 名称 | 租户名称 |
| 别名 | Schema 前缀 |
| 套餐 | free/pro/enterprise |
| 状态 | 启用/禁用 |
| 项目数 | 当前/限制 (如 3/5) |
| 存储用量 | 当前/配额 (如 500MB/1GB) |
| 创建时间 | - |
| 操作 | 编辑、禁用、删除 |

### 5.2 编辑租户对话框

**基础信息 Tab**：

| 字段 | 类型 | 可编辑 |
|------|------|--------|
| 租户名称 | 文本 | ✅ |
| 描述 | 文本域 | ✅ |
| 别名 | 文本 | ❌ (创建后不可改) |

**配置管理 Tab**：

| 字段 | 类型 |
|------|------|
| 套餐 | 下拉选择 (free/pro/enterprise) |
| 状态 | 开关 (启用/禁用) |

**配额调整 Tab**：

| 字段 | 类型 | 单位 |
|------|------|------|
| 存储限制 | 数字输入 | MB |
| 项目数限制 | 数字输入 | 个 |
| 用户数限制 | 数字输入 | 个 |

### 5.3 状态切换逻辑

- 禁用租户：该租户下所有项目 API 返回 403
- 启用租户：恢复正常访问
- 禁用前需确认："禁用后该租户将无法访问，是否继续？"

### 5.4 删除租户

- 需输入租户别名确认
- 显示警告："此操作将删除租户及其所有项目、数据、备份，不可恢复！"
- 仅超级管理员可执行

### 5.5 数据库变更

```sql
ALTER TABLE druvia_tenants ADD COLUMN description TEXT;
ALTER TABLE druvia_tenants ADD COLUMN storage_limit BIGINT DEFAULT 1073741824;
ALTER TABLE druvia_tenants ADD COLUMN project_limit INT DEFAULT 5;
ALTER TABLE druvia_tenants ADD COLUMN user_limit INT DEFAULT 10;
```

---

## 数据库变更汇总

### 新增表

1. `druvia_settings` - 平台配置存储
2. `druvia_activity_logs` - 活动日志

### 修改表

1. `druvia_users` - 增加 `role` 字段
2. `druvia_tenants` - 增加 `description`, `storage_limit`, `project_limit`, `user_limit` 字段

---

## API 端点规划

### 用户管理
- `POST /api/v1/users` - 创建用户
- `PATCH /api/v1/users/:id` - 编辑用户
- `POST /api/v1/users/:id/reset-password` - 重置密码

### 备份管理
- `GET /api/v1/backups/:id/download` - 下载备份
- `POST /api/v1/backups/:id/restore` - 恢复备份
- `DELETE /api/v1/backups/:id` - 删除备份

### 设置管理
- `GET /api/v1/settings` - 获取设置
- `PATCH /api/v1/settings` - 更新设置
- `PATCH /api/v1/users/me` - 更新当前用户信息
- `POST /api/v1/users/me/password` - 修改密码

### 租户管理
- `PATCH /api/v1/tenants/:id` - 编辑租户

### 仪表板
- `GET /api/v1/dashboard/stats` - 统计数据
- `GET /api/v1/dashboard/trends` - 趋势数据
- `GET /api/v1/dashboard/activities` - 活动日志
- `GET /api/v1/dashboard/resources` - 资源使用情况
