# Druvia 战略设计文档

## 概述

基于 InsForge 竞品分析，重新定义 Druvia 的产品定位和开发方向。

**创建日期**: 2026-03-03
**状态**: 已批准

### 相关文档

- [开发者体验增强设计](./2026-03-02-developer-experience-design.md) - Phase 1/2 详细设计
- [Phase 1 实施计划](./2026-03-02-phase1-implementation.md) - ✅ 已完成
- [Phase 2 综合实施计划](./2026-03-03-phase2-comprehensive-plan.md) - 🆕 MVP 完整实施计划
- [Phase 2 SQL 编辑器计划](./2026-03-02-phase2-implementation.md) - M3/M4 详细实现

---

## 一、产品定位

### 核心定位

> 面向中文开发者的自托管 BaaS 平台，提供类 Supabase 体验，同时支持 Hasura GraphQL 生态和国内应用认证集成。

### 核心卖点

| 维度 | 描述 |
|------|------|
| **中文优先** | 全中文界面，降低使用门槛 |
| **认证集成** | 微信/钉钉/飞书 + 通用 OAuth（Google/GitHub 等） |
| **计算能力** | Edge Functions（Deno Worker 自托管） |
| **数据层** | Hasura GraphQL + Subscriptions |
| **成本优化** | 自托管友好，降低云服务费用 |

### 目标用户

- 独立开发者
- 创业团队

### 使用模式

- **默认**：单租户 + 多项目
- **扩展**：多租户（远期企业级场景）

---

## 二、与竞品对比

### Druvia vs InsForge vs Supabase

| 维度 | Druvia | InsForge | Supabase |
|------|--------|----------|----------|
| **数据隔离** | Schema-per-Tenant | Row-Level Security | Row-Level Security |
| **GraphQL** | Hasura (强) | 无 | 有限支持 |
| **认证** | 国内 + 国际 | 国际为主 | 国际为主 |
| **Edge Functions** | Deno Worker (自托管) | Deno Worker (自托管) | Deno |
| **Realtime** | Hasura Subscriptions | WebSocket | Realtime Server |
| **自托管** | 优化 | 支持 | 复杂 |
| **界面语言** | 中文 | 英文 | 英文 |

### Druvia 差异化优势

1. **Hasura 生态**：GraphQL Subscriptions 开箱即用
2. **中国区优化**：微信/钉钉/飞书认证
3. **自托管成本低**：架构简洁，资源占用少
4. **中文界面**：降低国内开发者使用门槛

---

## 三、架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Druvia Platform                         │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Admin UI    │  │ Client SDK  │  │ GraphQL Playground  │  │
│  │ (Next.js)   │  │ (远期)      │  │ (Hasura Console)    │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│         ▼                ▼                     ▼             │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                   API Gateway (Fastify)                 │ │
│  │  • Auth / Storage / Projects / Tables / Functions API   │ │
│  └────────────────────────────────────────────────────────┘ │
│         │                │                     │             │
│         ▼                ▼                     ▼             │
│  ┌──────────┐     ┌──────────┐          ┌──────────┐        │
│  │  Hasura  │     │   Deno   │          │  Redis   │        │
│  │ GraphQL  │     │  Worker  │          │  Cache   │        │
│  │  + Subs  │     │ (新增)   │          │          │        │
│  └────┬─────┘     └────┬─────┘          └────┬─────┘        │
│       │                │                     │               │
│       ▼                ▼                     ▼               │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              PostgreSQL (Schema-per-Project)            ││
│  └─────────────────────────────────────────────────────────┘│
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────────────────────────────────────────────────┐│
│  │           Storage Backend (R2 / S3 / Local)             ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### Docker Compose 结构

```yaml
services:
  druvia-postgres:    # PostgreSQL 17
  druvia-redis:       # Redis 7
  druvia-hasura:      # Hasura CE 2.48
  druvia-deno:        # Deno Worker (新增)
  # druvia-api:       # Fastify API (pm2 部署)
  # druvia-admin:     # Next.js Admin (pm2 部署)
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| GraphQL 层 | Hasura | 保持现有生态，Subscriptions 开箱即用 |
| Edge Functions | Deno Worker | 借鉴 InsForge，自托管无外部依赖 |
| Realtime | Hasura Subscriptions | 已有能力，无需自建 WebSocket |
| 存储 | 现有适配器 | R2/S3/Local 已实现 |

---

## 四、MVP 功能模块

### 功能清单

| 模块 | 状态 | 说明 |
|------|------|------|
| M1: 表数据 CRUD | ✅ 已完成 | SVAR DataGrid |
| M2: 快速建表模板 | ✅ 已完成 | 5 种模板 |
| M3: SQL 编辑器增强 | ✅ 已完成 | 多标签、语法高亮、自动完成 |
| M7: ER 图可视化 | ✅ 已完成 | reactflow + dagre 自动布局 |
| M11: 外键关系配置 | ✅ 已完成 | 建表/编辑表时配置外键 |
| M12: 侧边栏表列表 | ✅ 已完成 | 快速切换表、搜索过滤 |
| M13: JSON 单元格编辑器 | ✅ 已完成 | 语法高亮、格式化、弹窗编辑 |
| M14: 记录详情表单 | ✅ 已完成 | 字段类型适配、外键下拉 |
| M17: Authentication 管理界面 | ✅ 已完成 | OAuth 配置、用户管理 |
| M18: Storage 管理界面 | ✅ 已完成 | Buckets、文件管理、访问控制 |
| M19: Edge Functions | ✅ 已完成 | Deno Worker + 管理 UI |
| M20: Realtime 管理界面 | ✅ 已完成 | Hasura Subscriptions 可视化 |

### M17: Authentication 管理界面

**页面位置**: `/t/[tenantId]/p/[projectId]/auth`

**用户分层设计**:
```
┌─────────────────────────────────────────────────────┐
│ 平台用户 (druvia_users)                              │
│ • 管理后台登录                                       │
│ • 角色: super_admin / admin                         │
├─────────────────────────────────────────────────────┤
│ 项目用户 (tenant_xxx.users)                          │
│ • 业务应用用户                                       │
│ • 通过 Auth API 注册/登录                            │
│ • Profile 存储在租户 Schema                          │
└─────────────────────────────────────────────────────┘
```

**功能结构**:
```
├── Auth Methods (认证方式)
│   ├── Email/Password (内置)
│   ├── OAuth Providers
│   │   ├── 国际: Google, GitHub, Microsoft, Discord
│   │   └── 国内: 微信, 钉钉, 飞书
│   └── 启用/禁用切换
├── Users (用户列表)
│   ├── 查看所有用户
│   ├── 用户详情 (Profile)
│   └── 禁用/删除用户
└── Configurations (配置)
    ├── JWT 过期时间
    ├── 密码策略
    └── 邮件模板
```

**后端支持**: 扩展现有 `druvia_tenant_auth_providers` 表 + 新增配置 API

### M18: Storage 管理界面

**页面位置**: `/t/[tenantId]/p/[projectId]/storage`

**功能结构**:
```
├── Buckets (存储桶)
│   ├── 创建/删除桶
│   ├── 公开/私有设置
│   └── CORS 配置
├── Files (文件管理)
│   ├── 文件列表 (表格)
│   ├── 上传文件
│   ├── 预览/下载
│   ├── 删除文件
│   └── 获取公开 URL
└── Usage (用量统计)
    ├── 存储空间使用
    └── 带宽统计
```

**后端支持**:
- **重构 Storage 模块**：废弃 `druvia_files`，新建 `druvia_storage_buckets` + `druvia_storage_objects`
- **重写 `storage.service.ts`**：替代现有 `file.service.ts`
- **复用 Storage 适配器**：R2/S3/Local 适配器保持不变

### M19: Edge Functions

**页面位置**: `/t/[tenantId]/p/[projectId]/functions`

**功能结构**:
```
├── Functions (函数列表)
│   ├── 创建函数 (在线编辑器)
│   ├── 部署/更新
│   ├── 查看日志
│   └── 删除函数
├── Secrets (环境变量)
│   ├── 添加/编辑/删除
│   └── 加密存储
└── Schedules (定时任务)
    ├── Cron 表达式配置
    └── 执行历史
```

**技术实现**:
- 新增 `druvia-deno` Docker 容器
- 函数代码存储在 PostgreSQL
- API 调用 Deno Worker 执行函数

**安全设计**:
| 维度 | 限制 | 说明 |
|------|------|------|
| 执行超时 | 30s 默认，最大 300s | 防止无限循环 |
| 内存限制 | 128MB 默认，最大 512MB | 防止内存泄漏 |
| CPU 限制 | 单核 | 容器级别限制 |
| 网络访问 | 允许外部请求 | 可配置白名单 |
| 文件系统 | 只读（除 /tmp） | 防止持久化攻击 |
| 代码隔离 | 每次执行独立 Worker | 防止状态污染 |

### M20: Realtime 管理界面

**页面位置**: `/t/[tenantId]/p/[projectId]/realtime`

**功能结构**:
```
├── Subscriptions (订阅管理)
│   ├── 查看活跃订阅
│   ├── 表级订阅配置
│   └── 测试订阅
├── Events (事件日志)
│   ├── 实时事件流
│   └── 历史记录
└── Permissions (权限)
    ├── 基于 Hasura 权限
    └── 可视化配置
```

**技术实现**: 基于 Hasura Subscriptions，管理界面封装

### M7: ER 图可视化

**页面位置**: `/t/[tenantId]/p/[projectId]/tables` → "关系图" Tab

**功能**:
- 自动生成 ER 图（从外键关系）
- 拖拽布局
- 导出图片
- 点击跳转到表详情

**技术实现**: reactflow + 从 `information_schema` 读取外键

---

## 五、实施路线图

### Phase 划分

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: 基础架构 ✅ 已完成                                   │
│ ├── 租户/项目管理                                            │
│ ├── Schema-per-Tenant 隔离                                   │
│ └── 基础 API 框架                                            │
├─────────────────────────────────────────────────────────────┤
│ Phase 2: 核心功能 ✅ 已完成                                   │
│ ├── M1: 表数据 CRUD (SVAR DataGrid)                          │
│ ├── M2: 快速建表模板                                         │
│ └── M3: SQL 编辑器 (多标签、语法高亮、自动完成)                │
├─────────────────────────────────────────────────────────────┤
│ Phase 3: 管理界面 ✅ 已完成                                   │
│ ├── M7: ER 图可视化                                          │
│ ├── M11-M14: 外键配置、记录表单、JSON编辑、侧边栏              │
│ ├── M17: Authentication 管理界面                             │
│ ├── M18: Storage 管理界面                                    │
│ ├── M19: Edge Functions (Deno Worker)                        │
│ └── M20: Realtime 管理界面                                   │
├─────────────────────────────────────────────────────────────┤
│ Phase 4 (远期):                                              │
│ ├── M4: CSV 导入                                             │
│ ├── M16: MCP 集成                                            │
│ ├── Client SDK (@druvia/sdk)                                 │
│ └── 多租户企业版                                              │
└─────────────────────────────────────────────────────────────┘
```

### 已完成开发顺序

| 顺序 | 模块 | 状态 |
|------|------|------|
| 1 | M18: Storage 管理界面 | ✅ 已完成 |
| 2 | M17: Authentication 管理界面 | ✅ 已完成 |
| 3 | M20: Realtime 管理界面 | ✅ 已完成 |
| 4 | M3: SQL 编辑器 | ✅ 已完成 |
| 5 | M19: Edge Functions | ✅ 已完成 |
| 6 | M7: ER 图 | ✅ 已完成 |

---

## 六、技术选型

### 新增依赖

| 功能 | 包/技术 | 版本 | 用途 |
|------|---------|------|------|
| ER 图 | reactflow | 11.11.4 | 关系图绘制 |
| SQL 编辑器 | @uiw/react-codemirror | 4.25.5 | 代码编辑 |
| SQL 语法 | @codemirror/lang-sql | 6.10.0 | 语法高亮 |
| Edge Functions | denoland/deno:alpine | 2.x | 函数运行时 |

### Docker Compose 扩展

```yaml
# docker/docker-compose.yml 新增
services:
  druvia-deno:
    image: denoland/deno:alpine-2.0.6
    ports:
      - "7133:7133"
    volumes:
      - ./deno-functions:/app/functions
    environment:
      - DRUVIA_API_URL=http://druvia-api:3001
      - POSTGRES_URL=postgres://...
    depends_on:
      - druvia-postgres
```

### API 扩展

```
新增 API 端点:

# Authentication
GET/POST /api/v1/projects/:id/auth/providers
GET/POST /api/v1/projects/:id/auth/users
GET/PUT  /api/v1/projects/:id/auth/config

# Storage (重构后)
GET        /api/v1/projects/:id/storage/buckets              # 列出所有桶
POST       /api/v1/projects/:id/storage/buckets              # 创建桶
GET        /api/v1/projects/:id/storage/buckets/:name        # 获取桶详情
PATCH      /api/v1/projects/:id/storage/buckets/:name        # 更新桶配置
DELETE     /api/v1/projects/:id/storage/buckets/:name        # 删除桶
GET        /api/v1/projects/:id/storage/buckets/:name/objects           # 列出对象
POST       /api/v1/projects/:id/storage/buckets/:name/objects           # 上传对象 (auto key)
PUT        /api/v1/projects/:id/storage/buckets/:name/objects/:path     # 上传对象 (指定路径)
GET        /api/v1/projects/:id/storage/buckets/:name/objects/:path     # 下载对象
DELETE     /api/v1/projects/:id/storage/buckets/:name/objects/:path     # 删除对象
POST       /api/v1/projects/:id/storage/buckets/:name/objects/:path/url # 获取签名 URL

# Edge Functions
GET/POST   /api/v1/projects/:id/functions
GET/PUT    /api/v1/projects/:id/functions/:name
POST       /api/v1/projects/:id/functions/:name/invoke
GET/POST   /api/v1/projects/:id/functions/secrets
GET/POST   /api/v1/projects/:id/functions/schedules

# Realtime
GET        /api/v1/projects/:id/realtime/subscriptions
GET        /api/v1/projects/:id/realtime/events
```

### 数据库扩展

```sql
-- Edge Functions
CREATE TABLE druvia_functions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES druvia_projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  code TEXT NOT NULL,
  runtime VARCHAR(50) DEFAULT 'deno',
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, name)
);

CREATE TABLE druvia_function_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES druvia_projects(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, key)
);

CREATE TABLE druvia_function_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id UUID REFERENCES druvia_functions(id) ON DELETE CASCADE,
  cron_expression VARCHAR(100) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ
);

-- Storage（重构设计，废弃 druvia_files）
-- 采用 S3 模型：Buckets + Objects 分离

-- 存储桶
CREATE TABLE druvia_storage_buckets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES druvia_projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  public BOOLEAN DEFAULT false,
  file_size_limit BIGINT,              -- 单文件大小限制 (bytes)
  allowed_mime_types TEXT[],           -- 允许的 MIME 类型
  cors_config JSONB,                   -- CORS 配置
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, name)
);

-- 存储对象（替代 druvia_files）
CREATE TABLE druvia_storage_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id UUID REFERENCES druvia_storage_buckets(id) ON DELETE CASCADE,
  name VARCHAR(1024) NOT NULL,         -- 对象路径/名称 (支持目录结构如 avatars/user-123.jpg)
  size BIGINT NOT NULL,                -- 文件大小 (bytes)
  mime_type VARCHAR(255),              -- MIME 类型
  etag VARCHAR(255),                   -- 用于缓存验证
  storage_provider VARCHAR(50),        -- 存储后端 (r2/s3/local)
  storage_path VARCHAR(1024),          -- 后端实际存储路径
  metadata JSONB DEFAULT '{}',         -- 自定义元数据
  created_by UUID,                     -- 上传者 (可关联项目用户)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bucket_id, name)
);

-- 索引
CREATE INDEX idx_storage_objects_bucket ON druvia_storage_objects(bucket_id);
CREATE INDEX idx_storage_objects_created ON druvia_storage_objects(created_at DESC);

-- 迁移：删除旧表（需在迁移脚本中处理数据迁移）
-- DROP TABLE IF EXISTS druvia_files;
```

---

## 七、验收标准

### M3 SQL 编辑器增强
- [ ] SQL 语法高亮正常显示
- [ ] 表名/字段名自动完成
- [ ] 多标签支持（创建/切换/关闭）
- [ ] Cmd/Ctrl + Enter 执行查询
- [ ] 查询结果正确显示

### M17 Authentication 管理界面
- [ ] 可查看/配置 OAuth 提供商
- [ ] 可启用/禁用各认证方式
- [ ] 可查看项目用户列表
- [ ] 可查看用户详情（Profile）
- [ ] 可禁用/删除用户
- [ ] 可配置 JWT 过期时间
- [ ] 微信/钉钉/飞书配置正常工作

### M18 Storage 管理界面
- [ ] 可创建/删除存储桶
- [ ] 可设置桶的公开/私有属性
- [ ] 可配置 CORS
- [ ] 可上传文件（支持拖拽）
- [ ] 可预览图片/文档
- [ ] 可下载文件
- [ ] 可删除文件（单个/批量）
- [ ] 可获取公开 URL
- [ ] 显示存储用量统计

### M19 Edge Functions
- [ ] Deno Worker 容器正常运行
- [ ] 可创建函数（在线编辑器）
- [ ] 可编辑/更新函数代码
- [ ] 可部署函数
- [ ] 可调用函数并获取结果
- [ ] 函数执行超时正确处理
- [ ] Secrets 加密存储
- [ ] Secrets 可在函数中访问
- [ ] 定时任务按时触发
- [ ] 函数执行日志可查看

### M20 Realtime 管理界面
- [ ] 可查看活跃订阅列表
- [ ] 可配置表级订阅
- [ ] 可测试订阅功能（实时接收变更）
- [ ] 事件日志正常显示
- [ ] 可查看历史事件

### M7 ER 图可视化
- [ ] 自动从外键生成关系图
- [ ] 表节点显示表名和字段
- [ ] 关系线显示外键关联
- [ ] 可拖拽调整布局
- [ ] 可缩放/平移画布
- [ ] 可导出图片（PNG/SVG）
- [ ] 点击表节点跳转到表详情

---

## 八、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Deno Worker 集成复杂 | 延期 | 参考 InsForge 实现，简化初版功能 |
| 认证提供商配置繁琐 | 用户体验差 | 提供详细文档和默认配置 |
| Hasura Subscriptions 权限复杂 | 用户困惑 | 封装简化界面，隐藏复杂度 |
| Storage 重构数据迁移 | 现有文件丢失 | 编写迁移脚本，先备份再迁移 |
| file.service.ts 重写 | 引入 Bug | 保持 API 兼容，充分测试 |

---

**更新日期**: 2026-03-06
**审查状态**: MVP 已完成
**当前状态**: Phase 1-3 全部完成，进入 Phase 4 远期规划阶段
