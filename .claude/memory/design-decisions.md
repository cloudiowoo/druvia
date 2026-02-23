# Design Decisions

Druvia 项目关键设计决策记录。

---

## 2026-02-24: 技术选型

### 放弃 Drupal，选择 Node.js + Hasura

**背景**: 原 drubase 使用 Drupal 11 作为后端，但 Drupal 不适合 BaaS 场景。

**决策**:
- 后端: Node.js 22 LTS + Fastify 5
- API 引擎: Hasura CE 2.40+
- 数据库: PostgreSQL 17

**理由**:
1. Hasura 自动生成 GraphQL/REST API，减少 50%+ 开发量
2. Node.js 生态更适合 BaaS 开发
3. Hasura CE 是 Apache 2.0 许可，可商业化

---

## 2026-02-24: 多租户隔离模式

### 选择 Schema-per-Tenant

**备选方案**:
1. Database-per-Tenant: 每租户独立数据库
2. Schema-per-Tenant: 每租户独立 Schema ✅
3. Row-level isolation: 共享表 + tenant_id 列

**决策**: Schema-per-Tenant

**理由**:
1. 平衡隔离性和资源效率
2. 支持租户级 PostgreSQL 函数/视图
3. 便于备份/恢复单个租户
4. Hasura 原生支持多 Schema

---

## 2026-02-24: 权限控制方案

### 选择 Hasura 权限，不用 PostgreSQL RLS

**决策**: 使用 Hasura 权限规则，不使用 PostgreSQL Row Level Security

**理由**:
1. BaaS 场景所有访问都通过 API，不需要数据库层 RLS
2. Hasura 权限更灵活，支持列级权限
3. 简化架构，减少维护成本
4. 如果未来需要直连数据库场景，再补充 RLS

---

## 2026-02-24: Storage 方案

### 选择 Cloudflare R2 + Local 兜底

**备选方案**:
1. MinIO: 社区活跃度下降
2. Cloudflare R2: S3 兼容，无出口费用 ✅
3. AWS S3: 成熟但有出口费用
4. 本地文件系统: 简单但不支持分布式

**决策**: R2 优先 + Local 兜底，可插拔适配器架构

**理由**:
1. R2 无出口费用，适合 BaaS 场景
2. Local 保证 R2 不可用时的可用性
3. 适配器模式便于未来扩展

---

## 2026-02-24: 认证架构

### 选择可插拔 Auth Adapters

**决策**: 实现可插拔认证适配器，支持微信/钉钉/飞书/OIDC

**理由**:
1. 不同租户可能需要不同认证方式
2. 适配器模式隔离第三方 API 变更
3. 便于扩展新的认证提供商

---

## 2026-02-24: 自定义函数

### 不支持用户上传代码

**决策**: 不实现类似 Supabase Edge Functions 的用户代码运行时

**替代方案**:
1. PostgreSQL Functions: 纯数据操作
2. Hasura Actions: 调用 Node.js 端点
3. Event Triggers: 异步处理

**理由**:
1. 简化架构，降低安全风险
2. PostgreSQL Functions + Hasura Actions 可覆盖大部分场景
3. 如果用户需要复杂逻辑，可自行部署外部服务

---

## 2026-02-24: 实时订阅

### 使用 Hasura Subscriptions

**决策**: 使用 Hasura GraphQL Subscriptions 替代 Supabase Realtime

**理由**:
1. Hasura 内置支持，无需额外组件
2. GraphQL Subscriptions 更灵活
3. 与现有权限系统集成

---

## 命名规范

| 类型 | 格式 | 示例 |
|------|------|------|
| 租户 ID | `ten_` + base64url | `ten_abc123xyz` |
| 项目 ID | `proj_` + base64url | `proj_def456uvw` |
| 用户 ID | `usr_` + base64url | `usr_ghi789rst` |
| 备份 ID | `bak_` + base64url | `bak_jkl012mno` |
| 租户 Schema | `tenant_` + alias | `tenant_acme` |
| 项目 Schema | `tenant_` + alias + `_proj_` + alias | `tenant_acme_proj_shop` |
