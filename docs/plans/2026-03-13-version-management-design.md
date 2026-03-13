# Druvia 版本管理与案例迁移设计

## 概述

定义 Druvia 进入案例驱动开发阶段的版本管理策略，解决平台持续开发与线上案例产品稳定性之间的平衡问题。

**创建日期**: 2026-03-13
**状态**: 已批准

---

## 一、背景

### 当前状态

- Druvia 版本 `0.1.0`，无 git tag，仅 `main` 分支
- MVP 功能模块已完成（Auth、Database、Storage、GraphQL 等）
- 迁移文件为单向 forward-only，无回滚能力
- 无 schema 版本追踪机制

### 案例产品

- 小程序 + Next.js Web 应用（独立仓库）
- 原后端为 self-hosted Supabase，全量迁移到 Druvia
- 已上线低流量，可接受短暂停机
- 与 Druvia 部署在同一台服务器

### 开发节奏

- 迁移工作与 Druvia 功能开发交替进行
- 迁移中发现平台问题 → 切到 Druvia 修复 → 继续迁移

---

## 二、架构

```
druvia/ (本仓库)                    case-app/ (独立仓库)
├── main 分支                       ├── 自己的分支策略
├── Tag 发布 (v0.x.x)              └── .env → Druvia API URL
├── migrations/
│    ├── 001_init.up.sql
│    ├── 001_init.down.sql          同一台服务器
│    ├── 002_xxx.up.sql             ┌─────────────┐
│    └── 002_xxx.down.sql           │  Druvia 实例 │◀── case-app
└── docs/migration/                 │  (锁定 tag)  │
     └── supabase-compat.md        └─────────────┘
```
### 核心原则

- `main` 分支持续开发
- 稳定时打 tag，生产环境按 tag 部署
- 迁移文件改为 up/down 双向，支持回滚
- 两个仓库唯一耦合点是 Druvia 的 API 接口
- 案例产品代码不进入 Druvia 仓库

---

## 三、迁移文件改造

### 文件结构

当前迁移文件为单向，改为 up/down 双文件：

```
migrations/
├── 001_init_druvia.up.sql
├── 001_init_druvia.down.sql
├── 002_user_roles.up.sql
├── 002_user_roles.down.sql
├── ...
├── 012_create_project_environments.up.sql
├── 012_create_project_environments.down.sql
```

### Schema 版本追踪表

每个已应用的迁移对应一行，回滚时删除该行：

```sql
CREATE TABLE IF NOT EXISTS druvia_schema_versions (
  version INT PRIMARY KEY,             -- 迁移编号 (001, 002...)
  name VARCHAR(255) NOT NULL,          -- 迁移名称
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
```

- `migrate up`: 执行 `.up.sql` 并 INSERT 一行
- `migrate down`: 执行 `.down.sql` 并 DELETE 该行
- 当前版本 = `SELECT MAX(version) FROM druvia_schema_versions`

### Migrate 命令

实现为 `apps/api/src/cli/migrate.ts`，使用 `pg` 直连数据库，无额外依赖：

```bash
pnpm migrate up              # 执行所有未应用的 up 迁移
pnpm migrate down            # 回滚最后一个迁移
pnpm migrate down --to 010   # 回滚到指定版本
pnpm migrate status          # 查看当前迁移状态
```

在 `package.json` 中注册：

```json
{
  "scripts": {
    "migrate": "tsx apps/api/src/cli/migrate.ts"
  }
}
```
---

## 四、Tag 发布策略

```
main ──●──●──●──●──●──●──●──→
       │        │        │
    v0.1.0   v0.1.1   v0.2.0
```

### 版本号规则 (Semver)

| 变更类型 | 版本号 | 触发条件 |
|---------|--------|---------|
| patch (0.1.x) | Bug 修复、小调整 | 迁移中发现的 Bug |
| minor (0.x.0) | 新功能、新迁移文件 | 案例需要的新能力 |
| major (x.0.0) | 破坏性 API 变更 | 远期，暂不考虑 |

---

## 五、迁移兼容性文档

维护 `docs/migration/supabase-compat.md`，记录功能对照：

```markdown
| Supabase 功能 | Druvia 对应 | 状态 | 版本 | Issue |
|--------------|-------------|------|------|-------|
| supabase.auth.signUp() | POST /api/v1/auth/register | ✅ | v0.1.0 | |
| supabase.from().select() | GraphQL query | ✅ | v0.1.0 | |
| supabase.storage.upload() | POST /api/v1/.../objects | ✅ | v0.1.0 | |
| supabase.realtime | Hasura Subscriptions | 🚧 | - | #xx |
| RLS policies | - | ❌ | - | #xx |
```

每次打 tag 时更新状态和版本号。
---

## 六、日常工作流

```
case-app 仓库              druvia 仓库
    │                          │
    │ 迁移某模块               │
    │ 发现: 缺少 xxx           │
    │──── 记录 Issue ─────────▶│
    │                          │ 开发 xxx 功能
    │                          │ 写 migration up/down
    │                          │ 本地测试通过
    │                          │ 提交到 main
    │                          │
    │                          │ 打 tag v0.1.1
    │                          │ 生产部署
    │◀── 更新完成 ────────────│
    │                          │
    │ 继续迁移                 │ 更新 compat 文档
```

### 生产部署

生产环境使用 Docker Compose（`docker-compose.prod.yml`）：

```bash
cd druvia
git fetch origin
git checkout v0.1.1
pnpm install && pnpm build

# 执行迁移（在宿主机或通过 docker exec）
pnpm migrate up

# 重建并重启容器
cd docker && docker compose -f docker-compose.prod.yml up -d --build
```

迁移命令在容器外执行（宿主机直连 PostgreSQL），因为迁移是一次性操作，不需要容器化。

### 回滚

回滚时需确认 tag 与迁移版本的对应关系：

```bash
# 1. 查看当前迁移版本
pnpm migrate status

# 2. 查看目标 tag 对应的最高迁移编号
git show v0.1.0:migrations/ | ls  # 确认该 tag 包含哪些迁移

# 3. 回滚数据库
pnpm migrate down --to <目标迁移编号>

# 4. 回滚代码
git checkout v0.1.0
pnpm install && pnpm build
cd docker && docker compose -f docker-compose.prod.yml up -d --build
```

---

## 七、实施步骤

1. 给当前代码打 `v0.1.0` tag 作为基线
2. 现有 12 个迁移文件重命名为 `.up.sql`，补充 `.down.sql`
3. 实现 migrate 命令（`apps/api/src/cli/migrate.ts`）：
   - 创建 `druvia_schema_versions` 表（自动创建）
   - 实现 `up`/`down`/`status` 子命令
   - 使用 `pg` 直连，读取 `migrations/` 目录
4. 引导已有迁移：首次运行时将 12 个已存在的迁移标记为已应用（检测表是否存在来判断）
5. 创建 `docs/migration/supabase-compat.md` 模板
6. 开始案例迁移工作

---

*Last Updated: 2026-03-13*
