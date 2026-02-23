# Druvia - 项目结构与部署

> 创建日期: 2026-02-24
> 父文档: 2026-02-24-druvia-design.md

## 一、项目结构

```
druvia/
├── apps/
│   ├── api/                          # Node.js 管理层
│   │   ├── src/
│   │   │   ├── adapters/             # 可插拔适配器层
│   │   │   │   ├── storage/
│   │   │   │   │   ├── interface.ts
│   │   │   │   │   ├── r2.adapter.ts
│   │   │   │   │   ├── local.adapter.ts
│   │   │   │   │   ├── s3.adapter.ts
│   │   │   │   │   └── index.ts
│   │   │   │   ├── auth/
│   │   │   │   │   ├── interface.ts
│   │   │   │   │   ├── wechat.adapter.ts
│   │   │   │   │   ├── dingtalk.adapter.ts
│   │   │   │   │   ├── feishu.adapter.ts
│   │   │   │   │   ├── oidc.adapter.ts
│   │   │   │   │   └── index.ts
│   │   │   │   └── index.ts
│   │   │   ├── modules/
│   │   │   │   ├── tenant/           # 租户管理
│   │   │   │   │   ├── tenant.controller.ts
│   │   │   │   │   ├── tenant.service.ts
│   │   │   │   │   └── tenant.routes.ts
│   │   │   │   ├── project/          # 项目管理
│   │   │   │   │   ├── project.controller.ts
│   │   │   │   │   ├── project.service.ts
│   │   │   │   │   └── project.routes.ts
│   │   │   │   ├── schema/           # Schema 管理
│   │   │   │   │   ├── table.controller.ts
│   │   │   │   │   ├── table.service.ts
│   │   │   │   │   ├── function.controller.ts
│   │   │   │   │   ├── function.service.ts
│   │   │   │   │   ├── view.controller.ts
│   │   │   │   │   ├── view.service.ts
│   │   │   │   │   └── schema.routes.ts
│   │   │   │   ├── auth/             # 认证服务
│   │   │   │   │   ├── auth.controller.ts
│   │   │   │   │   ├── auth.service.ts
│   │   │   │   │   └── auth.routes.ts
│   │   │   │   ├── storage/          # 存储服务
│   │   │   │   │   ├── storage.controller.ts
│   │   │   │   │   ├── storage.service.ts
│   │   │   │   │   └── storage.routes.ts
│   │   │   │   ├── backup/           # 备份服务
│   │   │   │   │   ├── backup.controller.ts
│   │   │   │   │   ├── backup.service.ts
│   │   │   │   │   └── backup.routes.ts
│   │   │   │   └── proxy/            # Hasura 代理
│   │   │   │       ├── proxy.controller.ts
│   │   │   │       └── proxy.routes.ts
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts           # JWT 验证
│   │   │   │   ├── rateLimit.ts      # 限流
│   │   │   │   ├── cache.ts          # 缓存
│   │   │   │   ├── tenant.ts         # 租户上下文
│   │   │   │   └── error.ts          # 错误处理
│   │   │   ├── lib/
│   │   │   │   ├── db.ts             # PostgreSQL 连接
│   │   │   │   ├── redis.ts          # Redis 连接
│   │   │   │   ├── hasura.ts         # Hasura 客户端
│   │   │   │   ├── ddl.ts            # DDL 生成器
│   │   │   │   └── crypto.ts         # 加密工具
│   │   │   ├── config/
│   │   │   │   └── index.ts          # 配置管理
│   │   │   └── index.ts
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   └── admin/                        # Next.js 管理界面
│       ├── src/
│       │   ├── app/                  # App Router
│       │   │   ├── (auth)/
│       │   │   │   ├── login/
│       │   │   │   └── register/
│       │   │   ├── (dashboard)/
│       │   │   │   ├── layout.tsx
│       │   │   │   ├── page.tsx
│       │   │   │   ├── tenants/
│       │   │   │   ├── projects/
│       │   │   │   │   └── [id]/
│       │   │   │   │       ├── page.tsx
│       │   │   │   │       ├── tables/
│       │   │   │   │       ├── data/
│       │   │   │   │       ├── functions/
│       │   │   │   │       ├── views/
│       │   │   │   │       ├── storage/      # 文件浏览器
│       │   │   │   │       ├── backups/      # 备份管理
│       │   │   │   │       ├── sql/          # SQL 编辑器
│       │   │   │   │       └── settings/
│       │   │   │   │           ├── general/
│       │   │   │   │           ├── auth/     # 认证配置
│       │   │   │   │           └── storage/  # 存储配置
│       │   │   │   └── settings/
│       │   │   └── layout.tsx
│       │   ├── components/
│       │   │   ├── ui/               # shadcn/ui
│       │   │   ├── layout/
│       │   │   ├── tables/
│       │   │   ├── forms/
│       │   │   ├── storage/          # 文件浏览器组件
│       │   │   ├── backup/           # 备份管理组件
│       │   │   └── charts/
│       │   ├── lib/
│       │   │   ├── api/              # API 客户端
│       │   │   ├── auth/
│       │   │   └── utils/
│       │   └── hooks/
│       ├── package.json
│       ├── tsconfig.json
│       ├── tailwind.config.ts
│       └── Dockerfile
│
├── packages/
│   └── shared/                       # 共享类型/工具
│       ├── src/
│       │   ├── types/
│       │   │   ├── tenant.ts
│       │   │   ├── project.ts
│       │   │   ├── storage.ts
│       │   │   ├── auth.ts
│       │   │   └── index.ts
│       │   └── utils/
│       │       ├── id.ts             # ID 生成
│       │       └── validation.ts     # 验证工具
│       └── package.json
│
├── docker/
│   ├── docker-compose.yml
│   ├── docker-compose.dev.yml
│   └── hasura/
│       └── metadata/
│           ├── actions.yaml
│           ├── tables.yaml
│           └── ...
│
├── migrations/
│   ├── 001_init_druvia.sql
│   └── ...
│
├── docs/
│   └── plans/
│       ├── 2026-02-24-druvia-design.md
│       ├── 2026-02-24-druvia-adapters.md
│       ├── 2026-02-24-druvia-database.md
│       ├── 2026-02-24-druvia-api.md
│       └── 2026-02-24-druvia-structure.md
│
├── pnpm-workspace.yaml
├── turbo.json
├── .env.example
└── README.md
```

---

## 二、Docker Compose 配置

```yaml
# docker/docker-compose.yml
version: '3.8'

services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: druvia
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: druvia
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U druvia"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  hasura:
    image: hasura/graphql-engine:v2.40.0
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      HASURA_GRAPHQL_DATABASE_URL: postgres://druvia:${POSTGRES_PASSWORD}@postgres:5432/druvia
      HASURA_GRAPHQL_ADMIN_SECRET: ${HASURA_ADMIN_SECRET}
      HASURA_GRAPHQL_ENABLE_CONSOLE: "false"
      HASURA_GRAPHQL_JWT_SECRET: '{"type":"HS256","key":"${JWT_SECRET}"}'
      HASURA_GRAPHQL_ENABLE_ALLOWLIST: "false"
      HASURA_GRAPHQL_ENABLE_TELEMETRY: "false"
      HASURA_GRAPHQL_UNAUTHORIZED_ROLE: "anonymous"
      DRUVIA_API_URL: http://api:3001
    ports:
      - "8080:8080"

  api:
    build:
      context: ../apps/api
      dockerfile: Dockerfile
    depends_on:
      hasura:
        condition: service_started
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://druvia:${POSTGRES_PASSWORD}@postgres:5432/druvia
      HASURA_ENDPOINT: http://hasura:8080
      HASURA_ADMIN_SECRET: ${HASURA_ADMIN_SECRET}
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      # Storage 配置
      STORAGE_PROVIDER: ${STORAGE_PROVIDER:-local}
      STORAGE_LOCAL_PATH: /data/storage
      STORAGE_R2_ACCOUNT_ID: ${R2_ACCOUNT_ID:-}
      STORAGE_R2_ACCESS_KEY: ${R2_ACCESS_KEY:-}
      STORAGE_R2_SECRET_KEY: ${R2_SECRET_KEY:-}
      STORAGE_R2_BUCKET: ${R2_BUCKET:-}
      STORAGE_R2_PUBLIC_URL: ${R2_PUBLIC_URL:-}
      # 微信配置 (可选)
      WECHAT_APP_ID: ${WECHAT_APP_ID:-}
      WECHAT_APP_SECRET: ${WECHAT_APP_SECRET:-}
    volumes:
      - storage_data:/data/storage
      - backup_data:/data/backups
    ports:
      - "3001:3001"

  admin:
    build:
      context: ../apps/admin
      dockerfile: Dockerfile
    depends_on:
      - api
    environment:
      NEXT_PUBLIC_API_URL: ${PUBLIC_API_URL:-http://localhost:3001}
      NEXT_PUBLIC_HASURA_URL: ${PUBLIC_HASURA_URL:-http://localhost:8080}
    ports:
      - "3000:3000"

volumes:
  postgres_data:
  storage_data:
  backup_data:
```

---

## 三、环境变量

```bash
# .env.example

# ============ Database ============
POSTGRES_PASSWORD=your_secure_password_here

# ============ Hasura ============
HASURA_ADMIN_SECRET=your_hasura_admin_secret_here

# ============ JWT ============
JWT_SECRET=your_jwt_secret_min_32_characters_here

# ============ Storage ============
# Provider: local | r2 | s3
STORAGE_PROVIDER=local

# Cloudflare R2 (如果 STORAGE_PROVIDER=r2)
R2_ACCOUNT_ID=
R2_ACCESS_KEY=
R2_SECRET_KEY=
R2_BUCKET=druvia-storage
R2_PUBLIC_URL=https://your-bucket.r2.dev

# AWS S3 (如果 STORAGE_PROVIDER=s3)
S3_REGION=
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_BUCKET=
S3_ENDPOINT=

# ============ 微信小程序 (可选) ============
WECHAT_APP_ID=
WECHAT_APP_SECRET=

# ============ 钉钉 (可选) ============
DINGTALK_APP_KEY=
DINGTALK_APP_SECRET=

# ============ 飞书 (可选) ============
FEISHU_APP_ID=
FEISHU_APP_SECRET=

# ============ Public URLs ============
PUBLIC_API_URL=https://api.yourdomain.com
PUBLIC_HASURA_URL=https://hasura.yourdomain.com
```

---

## 四、开发计划

| 阶段 | 内容 | 周期 |
|------|------|------|
| **Phase 1** | 基础架构 (租户/Schema/认证) | 2 周 |
| **Phase 2** | 表管理 + 数据 API | 2 周 |
| **Phase 3** | 函数/视图管理 | 1.5 周 |
| **Phase 4** | 限流/缓存/安全 | 1 周 |
| **Phase 5** | Adapters 层 | 2 周 |
|  | - Storage Adapters (R2/Local/S3) | 1 周 |
|  | - Auth Adapters (微信/钉钉/飞书/OIDC) | 1 周 |
| **Phase 6** | Backup 服务 | 1 周 |
| **Phase 7** | Admin 界面核心页面 | 3 周 |
| **Phase 8** | 高级功能 (SQL 编辑器/文件浏览器/备份管理) | 2 周 |
| **Phase 9** | 测试/文档/部署 | 1 周 |
| **总计** | | **15.5 周** |

### Phase 5 详细拆分

```
Week 1: Storage Adapters
├── Day 1-2: 接口设计 + Local Adapter
├── Day 3-4: R2 Adapter + S3 Adapter
└── Day 5: Storage Service + API 端点 + 测试

Week 2: Auth Adapters
├── Day 1-2: 接口设计 + WeChat Adapter (小程序+公众号)
├── Day 3: DingTalk + Feishu Adapters
├── Day 4: OIDC Adapter (通用)
└── Day 5: Auth Service 整合 + 租户配置 + 测试
```

---

## 五、风险与缓解

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|---------|
| Hasura 依赖 | 低 | 中 | Apache 2.0 可 fork |
| Schema 数量过多 | 中 | 中 | 监控 + 清理策略 |
| 性能瓶颈 | 中 | 中 | Redis 缓存 + 连接池 |
| 安全风险 | 低 | 高 | JWT + 限流 + 审计 |
| 许可证变更 | 极低 | 中 | 可 fork 当前版本 |
| R2 服务不可用 | 低 | 中 | Local Adapter 自动降级 |
| 第三方认证 API 变更 | 中 | 中 | 适配器隔离，仅需更新单个 Adapter |
| 备份文件过大 | 中 | 低 | 增量备份 + 压缩 + 过期清理 |
| 微信 API 限流 | 中 | 低 | 缓存 session_key + 静默登录优先 |

---

## 六、验收标准

### 6.1 功能验收

**核心功能**
- [ ] 租户创建后自动创建 Schema
- [ ] 可视化创建表并生成正确 DDL
- [ ] 数据 CRUD 通过 Hasura API 正常工作
- [ ] PostgreSQL 函数可创建并通过 RPC 调用
- [ ] 物化视图可创建并刷新
- [ ] JWT 认证正常工作
- [ ] 租户级限流生效
- [ ] 管理界面所有页面可用

**Storage 模块**
- [ ] 文件上传到 R2 成功，返回公开 URL
- [ ] R2 不可用时自动降级到 Local 存储
- [ ] 租户间文件隔离（不同 bucket prefix）
- [ ] 文件大小/类型限制生效
- [ ] 管理界面文件浏览器可用

**Auth Adapters 模块**
- [ ] 微信小程序登录流程正常（code → session）
- [ ] 微信静默登录正常（cached openid）
- [ ] 租户可配置启用/禁用认证方式
- [ ] 第三方账号与本地用户正确绑定
- [ ] OIDC 通用适配器可对接 Google/GitHub

**Backup 模块**
- [ ] 手动创建备份成功，生成 SQL dump
- [ ] 备份文件上传到 Storage
- [ ] 恢复备份到原 Schema 成功
- [ ] 恢复备份到新 Schema 成功
- [ ] 备份列表/下载/删除功能正常

**Realtime 模块**
- [ ] Hasura Subscriptions 配置正确
- [ ] 客户端可订阅表变更
- [ ] 权限控制生效（仅订阅有权限的数据）

### 6.2 性能验收

- [ ] API 响应时间 < 100ms (P95)
- [ ] 支持 1000+ 并发连接
- [ ] Schema 创建时间 < 5s
- [ ] 文件上传 < 3s (10MB 文件)
- [ ] 备份创建 < 30s (100 表)

---

## 七、许可证策略

| 组件 | 许可证 | 商业使用 |
|------|--------|---------|
| Hasura CE | Apache 2.0 | ✅ 允许 |
| PostgreSQL | PostgreSQL License | ✅ 允许 |
| Node.js | MIT | ✅ 允许 |
| Next.js | MIT | ✅ 允许 |
| shadcn/ui | MIT | ✅ 允许 |
| **Druvia 自有代码** | 自定义 | 完全自主 |

所有依赖组件均为商业友好许可证，Druvia 可自由商业化。

---

## 八、参考资料

- [Hasura GraphQL Engine](https://hasura.io/docs/)
- [PostgreSQL 17 Documentation](https://www.postgresql.org/docs/17/)
- [Next.js 16 Documentation](https://nextjs.org/docs)
- [shadcn/ui Components](https://ui.shadcn.com/)
- [Supabase Architecture](https://supabase.com/docs/guides/getting-started/architecture)
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
