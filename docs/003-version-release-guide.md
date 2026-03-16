# Druvia 版本发布与迁移操作手册

> 版本管理、数据库迁移、Tag 发布的标准操作流程。

**创建日期**: 2026-03-16
**当前版本**: v0.1.0
**基线 Commit**: `632ae90`

---

## 一、迁移系统概览

### 组件

| 组件 | 路径 | 说明 |
|------|------|------|
| CLI 工具 | `apps/api/src/cli/migrate.ts` | 迁移命令入口 |
| 迁移文件 | `migrations/NNN_name.{up,down}.sql` | 双向迁移脚本 |
| 版本追踪表 | `druvia_schema_versions` | 记录已应用的迁移 |
| 兼容性文档 | `docs/migration/supabase-compat.md` | Supabase 功能对照 |

### 命令

```bash
pnpm migrate up              # 执行所有未应用的迁移
pnpm migrate down            # 回滚最后一个迁移
pnpm migrate down --to N     # 回滚到版本 N（保留 N）
pnpm migrate status          # 查看迁移状态
pnpm migrate bootstrap       # 标记已有迁移为已应用（仅首次）
```

### 安全机制

- **Advisory Lock**: `pg_try_advisory_lock(20260313)` 防止并发迁移
- **事务保护**: 每个迁移在独立事务中执行，失败自动 ROLLBACK
- **Bootstrap 检测**: 表存在性 + 数据行查询双重检测

---

## 二、场景操作流程

### 场景 A：全新部署

```bash
# 1. 检出目标版本
git checkout v0.x.x
pnpm install && pnpm build

# 2. 执行全部迁移（从 000 开始）
pnpm migrate up

# 3. 验证
pnpm migrate status
# Expected: 所有迁移 ✓，当前版本 = 最高编号

# 4. 启动服务
cd docker && docker compose -f docker-compose.prod.yml up -d --build
```

### 场景 B：已有数据库首次接入迁移系统

适用于：数据库已通过手动 SQL 建好表，但没有 `druvia_schema_versions` 追踪记录。

```bash
# 1. Bootstrap — 自动检测已有表和数据，标记为已应用
pnpm migrate bootstrap

# 2. 验证
pnpm migrate status
# Expected: 001-012 全部 ✓（包括 010 数据迁移），当前版本 12
```

Bootstrap 检测逻辑：

| 版本 | 检测方式 | 检测目标 |
|------|---------|---------|
| 001 | 表存在 | `druvia_users` |
| 002 | 表存在 | `druvia_users`（ALTER TABLE） |
| 003 | 表存在 | `druvia_tenants` |
| 004 | 表存在 | `druvia_settings` |
| 005 | 表存在 | `druvia_activity_logs` |
| 006 | 表存在 | `druvia_projects`（ALTER TABLE） |
| 007 | 表存在 | `druvia_storage_buckets` |
| 008 | 表存在 | `druvia_project_auth_providers` |
| 009 | 表存在 | `druvia_functions` |
| 010 | 数据行查询 | `druvia_tenants WHERE tenant_id = 'default'` |
| 011 | 表存在 | `druvia_api_keys` |
| 012 | 表存在 | `druvia_project_environments` |

注意事项：
- Bootstrap 只能执行一次，已有记录时会提示 "Already bootstrapped"
- 未检测到 `druvia_users` 表时判定为全新数据库，直接退出
- 未匹配的迁移会打印 `○ NNN name (not detected, skipped)`

### 场景 C：日常版本发布（打 Tag）

```bash
# 1. 确认迁移状态正常
pnpm migrate status

# 2. 确认工作区干净
git status
# Expected: nothing to commit, working tree clean

# 3. 确定版本号（Semver）
#    patch 0.1.x — Bug 修复、小调整
#    minor 0.x.0 — 新功能、新迁移文件
#    major x.0.0 — 破坏性 API 变更（远期）

# 4. 打 tag
git tag -a v0.x.x -m "v0.x.x: 变更描述"

# 5. 推送
git push origin v0.x.x

# 6. 更新 docs/migration/supabase-compat.md 中的版本标记
```

### 场景 D：生产环境升级

```bash
# 1. 拉取并切换到目标 tag
cd druvia
git fetch origin
git checkout v0.x.x

# 2. 构建
pnpm install && pnpm build

# 3. 执行迁移（宿主机直连 PostgreSQL，非容器内）
pnpm migrate up

# 4. 重建并重启容器
cd docker && docker compose -f docker-compose.prod.yml up -d --build
```

### 场景 E：生产环境回滚

```bash
# 1. 查看当前迁移版本
pnpm migrate status

# 2. 确认目标 tag 包含的迁移文件
git show v0.1.0:migrations/

# 3. 回滚数据库到目标版本
#    例：从版本 14 回滚到 12（保留 012 及以下）
pnpm migrate down --to 12

# 4. 回滚代码
git checkout v0.1.0
pnpm install && pnpm build

# 5. 重启容器
cd docker && docker compose -f docker-compose.prod.yml up -d --build
```

回滚注意事项：
- `down --to N` 保留版本 N，回滚 N 以上的所有迁移
- 不带 `--to` 默认只回滚最后一个
- 包含数据的迁移（如 010）回滚会删除数据，这是预期行为
- 回滚前建议备份数据库

---

## 三、新增迁移文件规范

```bash
# 1. 检查当前最高编号
ls migrations/*.up.sql

# 2. 创建 up/down 文件对
#    文件名: NNN_描述.up.sql / NNN_描述.down.sql
#    NNN 为三位数字，递增

# 3. up 脚本：创建/修改
# 4. down 脚本：精确反向操作

# 5. 本地测试往返
pnpm migrate up
pnpm migrate status
pnpm migrate down
pnpm migrate status
pnpm migrate up
```

命名规则：
- 编号三位数字，零填充：`013`、`014`...
- 名称 snake_case，描述变更内容
- 每个 up 必须有对应的 down

---

## 四、Tag 与迁移版本对照

| Git Tag | 迁移范围 | 说明 |
|---------|---------|------|
| v0.1.0 | 000-012 | 基线版本，迁移系统就绪 |

> 每次打 tag 时更新此表。

---

## 五、故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| "Another migration is running" | Advisory lock 未释放 | 检查是否有其他迁移进程；极端情况手动 `SELECT pg_advisory_unlock(20260313)` |
| Bootstrap 显示 "Already bootstrapped" | `druvia_schema_versions` 已有记录 | 正常，无需重复执行 |
| Bootstrap 跳过某版本 | 对应表或数据不存在 | 检查数据库实际状态，必要时手动 INSERT 版本记录 |
| `down` 执行失败 | down 脚本 SQL 错误 | 修复 down 脚本后重试，事务已自动 ROLLBACK |
| `process.exit()` 导致锁未释放 | finally 块被跳过 | 避免在迁移逻辑中使用 `process.exit()`；当前 CLI 已在 finally 中释放锁 |

---

*Last Updated: 2026-03-16*
