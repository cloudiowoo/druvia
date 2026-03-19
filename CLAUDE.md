# Druvia

自托管 BaaS 平台，Schema-per-Tenant 多租户隔离。

**Stack**: Node.js 22 + Fastify 5 + PostgreSQL 17 + Hasura CE 2.48 + Redis 7

**版本**: v0.2.0 | Phase 1 SDK 已完成 | Next.js 16 已升级（webpack 模式，Turbopack 因 Docker 兼容问题未启用）

---

## Commands

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装依赖 |
| `pnpm --filter @druvia/shared build` | 构建共享包（必须先于 API） |
| `pnpm dev` | 启动开发服务 |
| `pnpm build` | 生产构建 |
| `pnpm test` | 运行测试 |
| `make dev-up` | 启动 Docker 开发环境 |
| `make dev-down` | 停止 Docker 开发环境 |
| `pnpm migrate <up\|down\|status\|bootstrap>` | 数据库迁移管理 |

### Docker 生产部署

```bash
cd docker
docker compose -f docker-compose.prod.yml build        # 构建镜像
docker compose -f docker-compose.prod.yml up -d        # 启动服务
docker compose -f docker-compose.prod.yml --profile with-nginx up -d  # 含 nginx
```

### Docker 本地开发（挂载构建产物）

```bash
pnpm build
cp -r apps/admin/public apps/admin/.next/standalone/apps/admin/
cp -r apps/admin/.next/static apps/admin/.next/standalone/apps/admin/.next/
cd docker && docker compose -f docker-compose.local.yml --profile with-nginx up -d
# 修改后: pnpm build && docker compose -f docker-compose.local.yml restart api admin
```

---

## Architecture

```
druvia/
├── apps/api/          # Fastify 管理层 (port 3001)
├── apps/admin/        # Next.js 管理界面 (port 3000)
├── packages/shared/   # 共享类型/工具
├── packages/sdk/      # Client SDK (@druvia/sdk)
├── docker/            # Docker Compose 配置
├── migrations/        # SQL 迁移脚本（.up.sql / .down.sql）
├── apps/api/src/cli/  # CLI 工具（migrate）
├── tests/             # 测试目录 (unit/integration/e2e)
├── docs/plans/        # 设计文档 + 实施计划（命名：*-design.md / *-impl.md）
└── docs/migration/    # 迁移兼容性文档
```

### 功能状态（v0.2.0）

| 能力 | 状态 | 说明 |
|------|------|------|
| Auth（注册/登录/OAuth） | ✅ | 微信小程序+网页+OIDC；钉钉/飞书 adapter 未实现 |
| Database CRUD | ✅ | Hasura GraphQL，建表自动 track+权限 |
| Storage | ✅ | R2/S3/Local 适配器，上传/下载/签名URL |
| Realtime | ✅ | Hasura 原生 WebSocket 订阅，API 层管理配置 |
| Edge Functions | ⚠️ | API 层完整，Deno Worker 在 `docker/deno-worker/`（main.ts + executor.ts） |
| Hasura Actions | ⚠️ | 仅 4 个内置（register/login/me/create-tenant），无通用用户自定义 RPC |
| RLS | ❌ | Hasura 权限 filter 当前全开 `{}`，需手动配行级规则 |
| Image transformations | ❌ | Storage 层无图片处理 |
| Broadcast / Presence | ❌ | Hasura 不提供 |
| Client SDK | ⚠️ | `@druvia/sdk` Auth/CRUD/Storage/Realtime/RPC/Functions + API 层 RPC 代理已实现 |
| Refresh Token | ✅ | JWT + refresh token rotation，密码修改/停用自动撤销 |
| MCP Server | ✅ | `packages/mcp-server/`，5 个工具，生产可用 |

### Supabase 迁移判断

- **可迁移**：仅用 Auth + CRUD + Storage + Realtime 的应用
- **需改写**：用了 `supabase.rpc()` → 改为 GraphQL mutation 或 Hasura Action
- **需部署 Deno worker**：用了 Edge Functions
- **需手动配权限**：依赖 RLS 行级隔离的应用
- **暂不可迁**：依赖 Broadcast/Presence/图片变换的应用

---

## Key Files

- `apps/api/src/modules/` - 业务模块（project, table, schema, sql...）
- `apps/api/src/adapters/` - Storage/Auth 可插拔适配器
- `packages/shared/src/types.ts` - 共享类型定义
- `docker/docker-compose.yml` - 开发环境（仅基础设施）
- `docker/docker-compose.prod.yml` - 生产环境（完整镜像）
- `docker/docker-compose.local.yml` - 本地开发（挂载构建产物）
- `apps/api/src/cli/migrate.ts` - 数据库迁移 CLI（up/down/status/bootstrap）
- `docs/migration/supabase-compat.md` - Supabase → Druvia 兼容性对照
- `docker/deno-worker/` - Edge Functions Deno Worker（main.ts 服务端 + executor.ts 隔离执行）
- `docs/003-version-release-guide.md` - 版本发布与迁移操作手册
- `packages/mcp-server/` - MCP Server 包（list_tables/query_data/insert_row/execute_sql）

---

## Environment

| 服务 | 端口 | 容器名 |
|------|------|--------|
| API | 3001 | - |
| Admin | 3000 | - |
| Hasura | 8080 | druvia-hasura |
| PostgreSQL | 5432 | druvia-postgres |
| Redis | 6379 | druvia-redis |

---

## Gotchas

### Git
- **禁止自动提交**：设计/实施文档和代码均由用户确认后手动提交，使用 `/commit` 生成信息
- **Worktree 目录**：`.worktrees/`
- **SDK 关联检查**：API/前端功能更新后，检查 `packages/sdk/` 是否需要关联更新；如需要，设定任务告知用户，用户确认后再执行

### API
- **POST 空 body**：必须发送 `{}` 而非空 body，否则 `FST_ERR_CTP_EMPTY_JSON_BODY`
- **multipart/JSON 双模式**：先检查 `Content-Type` 再调用 `request.file()`
- **权限检查**：使用 `verifyProjectAccess(request, reply)` helper
- **verifyProjectAccess 模式**：每个 controller 内部定义，非共享 helper；import `checkProjectAccess` from `../../lib/access.js`
- **路由前缀**：所有路由注册在 `{ prefix: '/api/v1' }`，GraphQL 代理在 `openapi.routes.ts`
- **Refresh Token 撤销**：修改密码、停用账户时必须调用 `revokeUserRefreshTokens()`；`consumeRefreshToken` 需检查 `user.status === 'active'`
- **Fastify multipart filename 截断**：`data.filename` 只返回文件名不含目录；需通过 `?path=` query 参数传递完整路径
- **Storage 上传路由**：`POST /objects`（无通配符），文件路径通过 `?path=` 传递，非 URL path

### 数据库
- **BigInt 返回字符串**：用 `Number()` 或 `parseInt()` 转换
- **动态 SQL 标识符**：使用 `pg-format`（`%I` 标识符，`%L` 字面值）
- **命名规则**：表 `druvia_*` snake_case，TS 接口 camelCase
- **外键引用需 schema 前缀**：`REFERENCES "schema"."table"("column")` 而非 `REFERENCES "table"("column")`
- **Hasura 表追踪**：创建表后需调用 `trackTableInHasura()` 才能在 GraphQL 中使用
- **Schema 克隆外键问题**：`CREATE TABLE ... LIKE ... INCLUDING ALL` 会复制外键但不更新 schema 引用，需手动重建
- **迁移文件格式**：`NNN_name.up.sql` + `NNN_name.down.sql`，新建前先 `ls migrations/*.up.sql` 检查编号
- **当前最新迁移**：013（refresh_tokens），新建从 014 开始
- **迁移并发保护**：CLI 使用 `pg_advisory_lock`，勿用 `process.exit()` 跳过 finally 块
- **Bootstrap 双重检测**：`tableChecks` 检查表存在性，`dataChecks` 检查数据行（如 010 默认租户），新增纯数据迁移需在 `dataChecks` 中添加查询
- **druvia_users 表结构**：用 `username` 而非 `name`，必须提供 `user_id`
- **Project 对象字段**：`schema_name`（snake_case），非 `schemaName`
- **Hasura introspection 类型名**：格式为 `<schema>_<table>`（如 `dru_taroapp_users`），非简单表名

### 前端
- **CodeMirror 快捷键**：自定义 keymap 用 `Prec.highest()` 包装
- **状态同步**：登录/登出时同步 `useAuth.user` → `useAppStore.currentUser`
- **Radix Select 空值**：`<Select.Item />` value 不能为空字符串，用 `__NULL__` 常量代替
- **JSON.stringify(undefined)**：返回 `undefined` 不是字符串，需先检查再调用 `.length`
- **GraphiQL CSS**：必须导入 `graphiql/style.css`（含 CSS 变量），非 `graphiql/graphiql.css`
- **GraphiQL Monaco**：需先 `import('graphiql/setup-workers/webpack')` 再导入 GraphiQL，否则 `toUrl` 错误
- **Zod 验证错误**：使用 `.issues` 而非 `.errors` 获取验证错误列表
- **useEffect 依赖数组**：Zustand setter 函数（如 `setCurrentEnv`）放入依赖会导致无限循环，需排除并加 eslint-disable 注释
- **SDK realtime payload 类型**：`msg.payload` 是 `unknown`，访问嵌套属性需 `as Record<string, unknown>` 断言
- **fetch 204 响应**：DELETE 等返回 204 No Content 时不能调用 `response.json()`，需先检查 status

### 构建
- **顺序**：`pnpm --filter @druvia/shared build` 必须先于 API
- **合并后**：worktree 合并到 main 后需重新 `pnpm install`
- **Next.js standalone**：构建后需复制 `public/` 和 `.next/static/` 到 standalone 目录
- **SDK 导出**：`packages/sdk/src/` 下任何文件新增公开类型/类后必须同步更新 `packages/sdk/src/index.ts` 导出

### Docker
- **前端 API 地址**：生产环境 `NEXT_PUBLIC_API_URL=` 为空（使用相对路径通过 nginx）
- **数据目录**：`docker/postgres_data/`、`docker/redis_data/` 映射到主机
- **nginx 代理**：`/api/` → API，`/v1/graphql` → Hasura，`/` → Admin
- **Hasura WebSocket**：直连 `:8080/v1/graphql`，nginx 代理 `/v1/graphql` 和 `/v1/graphql/ws`，API `:3001` 不代理 WS

### Edge Functions
- **函数名精确匹配**：调用 `/functions/{name}/invoke` 时 name 必须与数据库 `druvia_functions.name` 完全一致
- **执行模式**：支持 Legacy（直接执行 + payload）和 Serve（`Deno.serve()` handler）两种模式
- **Supabase 迁移**：`import { serve } from "https://deno.land/std@..."` 改为 `Deno.serve()`

### 测试
- **位置**：`tests/` 目录，命名 `<module>.test.ts`
- **凭据**：`admin@druvia.local` / `88888888`

---

## Skills

领域知识按需加载，触发词激活：

| Skill | 触发词 |
|-------|--------|
| docker-guide | docker, 容器, compose |
| api-guide | API, Fastify, 限流 |
| database-guide | Schema, 迁移, JSONB |
| adapters-guide | Storage, Auth, R2, 微信 |
| hasura-guide | GraphQL, Subscriptions |
| testing-guide | 测试, vitest, TDD |

---

## Maintenance

修改 CLAUDE.md 时执行质量审计：
1. 评估 6 项标准（Commands/Architecture/Patterns/Conciseness/Currency/Actionability）
2. 目标 ~100 行，代码示例移至 Skills
3. Gotchas 集中展示，命令用表格
4. 验证命令可执行、路径存在

---

*Last Updated: 2026-03-19*
