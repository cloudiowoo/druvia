# Druvia 版本发布与迁移操作手册

> 版本管理、数据库迁移、Tag 发布的标准操作流程。

**创建日期**: 2026-03-16
**当前版本**: v0.2.0
**基线 Commit**: `f34c7cd`

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
# Expected: 已存在的迁移全部 ✓；旧 001-012 基线数据库的当前版本为 12
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
| 013 | 表存在 | `druvia_refresh_tokens` |
| 014 | 列存在 | 任一项目 schema 的 `_meta_tables.realtime_enabled` |
| 015 | 列存在 | `druvia_functions.invoke_auth_mode` |
| 016 | 表存在 | `druvia_project_refresh_tokens` |
| 017 | 表存在 | `druvia_trusted_backend_keys` |
| 018 | 列存在 | `druvia_projects.data_access_mode` |
| 019 | 表存在 | `druvia_data_access_migrations` |
| 020 | 两列同时存在 | `druvia_storage_buckets.project_user_access` 与 `druvia_storage_objects.owner_project_user_id` |
| 021 | 复合结构检测 | Apple Project Auth 三张 identity/lifecycle 表、refresh token 两列与约束 |
| 022 | 复合结构检测 | `druvia_project_members` 表、角色/唯一约束、成员索引与更新时间触发器 |

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

#### Batch 3A / 迁移 018 部署门禁

包含 Project Data Access Batch 3A 的版本必须先应用 `018_project_data_access_mode`，再启动新 API：

1. 部署目标 release 文件和镜像。
2. 运行迁移并确认 `druvia_projects.data_access_mode` 已存在。
3. 启动 API/Admin/Worker/Updater。
4. 验证已有项目仍为 `compatibility`，新建测试项目为 `explicit`。
5. 分别使用项目 API Key 和 Project access token 验证 GraphQL；平台 JWT 必须返回 `403 PROJECT_ACTOR_REQUIRED`。

OTA 仍使用既有 updater 流程，但 release manifest 对应的 API 镜像不能在迁移 `018` 未完成时创建新项目。

#### Batch 3B / Realtime 短期令牌部署门禁

包含 Realtime token exchange 的版本按以下顺序发布：

1. 盘点仍将平台 JWT 或自定义 JWT 直接发送到 Hasura 的客户端，特别标记缺少 `iss=druvia`、`aud=druvia-hasura` 的 token。
2. 在目标主机 `.env.prod` 配置独立、至少 32 字符的 `HASURA_JWT_SECRET`；API 签发和 Hasura 验签必须使用同一值。
3. 在 `.env.prod` 配置浏览器可达的 `HASURA_PUBLIC_URL`；同源部署可与必填的 `API_BASE_URL` 使用相同站点 origin，不能使用 `http://hasura:8080` 或 API 容器内地址。
4. 执行 `node scripts/release/verify-realtime-compose.mjs`，并用目标环境文件运行 `docker compose ... config`，确认 API/Hasura 使用同一有效密钥和正确公网 origin。
5. 由签名 release manifest 暂存并替换 `docker-compose.release.yml`，再重建 Hasura 和 API，使 verifier 的 issuer/audience 与 API 签发契约同时生效。
6. 部署 Admin 和 SDK consumers，确保 SDK 通过 Druvia API token exchange 建连，不直传长期凭证。
7. 分别以 compatibility API Key、explicit API Key 和 explicit Project Session 建立订阅；explicit 项目还必须验证跨项目表读取被拒绝。
8. 回滚旧客户端或旧 API 时，如其自定义 JWT 依赖旧 Hasura verifier JSON，必须同时恢复上一版 verifier 配置并重建 Hasura。

`HASURA_JWT_SECRET`、`HASURA_REALTIME_TOKEN_TTL_SECONDS` 和 `HASURA_PUBLIC_URL` 属于目标主机的持久部署配置，应保存在 `.env.prod`。OTA 会替换 release Compose，并只把 image/version 等发布值合并到 `.env.release`；不要依赖一次性 shell 变量保存这些值。本地 release OTA 演练例外：应在未跟踪的 `.env.release` 持久写入 `HASURA_PUBLIC_URL=http://localhost:8088`。

暂时不配置 `HASURA_JWT_SECRET` 时，API/Hasura 可以共同回退到 `JWT_SECRET`，API 会输出迁移警告。该回退只复用签名材料，不会让缺少新 issuer/audience 的旧直连 JWT 在 verifier 切换后继续有效；自动保留的兼容路径只有无 token 的 Hasura `anonymous` 连接。compatibility 的全局 `user` / `anonymous` permissions 仍是 Batch 4 迁移债务，不能作为跨项目隔离保证。

#### Batch 4 / 迁移 019 部署门禁

包含已有项目数据访问升级的版本必须先应用 `019_data_access_migrations`，再启动新 API/Admin。发布前先完成数据库和 Hasura metadata 备份；发布后通过 Admin 逐项目生成预检，不批量修改 `data_access_mode`。自定义旧规则会阻断，匿名写权限不会迁移，认证 aggregate 能力会收紧。

当前 release workflow 固定 `migration_required=true`、`migration_to=22`、`migration_requires_backup=true`、`migration_reversible=false`，手动发布不能覆盖这些安全字段；只有兼容起点 `migration_from` 保留为输入，默认值为 `18`。manifest 生成器会再次拒绝跳过迁移、目标不是 22、不备份或声明可自动回滚的合同。GHCR 与自建 Registry manifest 必须保持一致；未来新增迁移时需同步提升固定目标和对应契约测试。

迁移操作、恢复与回滚流程见 `docs/004-project-data-access-migration-guide.md`。`019` 保存恢复依据，镜像或 OTA 回滚时必须保留，不能自动执行 down migration。

#### Project Actor RPC / Functions 部署门禁

该切片没有 SQL migration，但同时改变 API、Deno Worker、SDK 和 OTA 回滚协议。发布前必须满足：

1. 在目标主机 `.env.prod` 配置至少 32 UTF-8 字节的 `DENO_WORKER_SECRET`，并确保 API 与 Worker 解析为完全相同的值。生产推荐另配独立 `FUNCTIONS_INTERNAL_TOKEN_SECRET`，两者都不要复用 `JWT_SECRET`。
2. 盘点使用 `druvia.graphql()` 的 Functions，为涉及表配置 Project Data Access 权限；未配置权限应按预期失败，禁止用宽泛 Hasura 权限作为发布补丁。
3. 盘点仍依赖 Platform Session 调用 SDK RPC/Functions 的应用，并在发布前建立 Project Session。匿名 Function 必须显式设为 `anon_allowed`；RPC 不支持 API Key 匿名调用。
4. 使用目标 `.env.prod/.env.release` 渲染 Compose，确认 local/prod/release 不发布 `7133`，Worker healthcheck 存在，API 与 Worker 使用同一 Worker secret，只有 API 接收 Function token 签名 secret。
5. API 和 Worker 必须来自同一 release manifest。升级时先使新 API 健康，再替换要求请求鉴权的新 Worker；不得无序并行切换两者。
6. 验证 Project User/API Key Function 调用及 `druvia.graphql()` 权限，确认 Platform Function 调用 GraphQL 返回 `PROJECT_ACTOR_REQUIRED`，并检查 Worker 日志不含 credential 或 payload。

OTA 自动和手动回滚都必须先基于已恢复的旧 Compose/env 执行 `docker compose up -d --no-deps deno`，再恢复完整服务集。原因是旧 API 不能调用要求新请求头的新 Worker；先恢复旧 Worker 可同时兼容新旧 API。该切片不需要数据库 down migration。

#### Storage Project User / 迁移 020 部署门禁

包含直接 Storage actor cutover 的版本必须在 API/Admin 启动前应用 `020_storage_project_user_access`。升级前完成数据库与 Storage 备份，并执行以下预检：对象逻辑名不得包含前后/重复斜杠、反斜杠、精确 `.`/`..` 段、控制字符或非 NFC 文本；Local 生产文件系统必须区分大小写，并按 `lower(storage_path)` 审计旧物理 key 冲突。

以下查询均为只读查询，正常结果应为零行。先处理所有结果并核对对应 provider 文件，再执行迁移：

```sql
-- 迁移 020 会拒绝的非规范逻辑名。
SELECT object_id, bucket_id, name, storage_provider, storage_path
FROM druvia_storage_objects
WHERE name = ''
   OR name LIKE '/%'
   OR name LIKE '%/'
   OR name LIKE '%//%'
   OR POSITION(E'\\' IN name) > 0
   OR name ~ '(^|/)\.{1,2}(/|$)'
   OR name ~ '[[:cntrl:]]'
   OR name <> normalize(name, NFC)
ORDER BY bucket_id, name;

-- Local 旧对象缺少可读取的物理 key。
SELECT object_id, bucket_id, name, storage_path
FROM druvia_storage_objects
WHERE storage_provider = 'local'
  AND nullif(btrim(storage_path), '') IS NULL
ORDER BY bucket_id, name;

-- 大小写不敏感文件系统上会指向同一文件的 Local key。
SELECT lower(storage_path) AS folded_storage_path,
       COUNT(*) AS object_count,
       array_agg(object_id ORDER BY object_id) AS object_ids,
       array_agg(storage_path ORDER BY storage_path) AS storage_paths
FROM druvia_storage_objects
WHERE storage_provider = 'local'
  AND nullif(btrim(storage_path), '') IS NOT NULL
GROUP BY lower(storage_path)
HAVING COUNT(*) > 1
ORDER BY folded_storage_path;
```

`020` 将所有旧 bucket 默认设为 `admin_only`，只从 `project_user` / `trusted_backend_project_user` 的非空可信 metadata 回填 owner。部署后由管理员逐 bucket 选择项目用户访问预设；不要批量打开公开访问。旧对象物理 key 不重写，新上传才使用 opaque object ID key。

镜像回滚不得自动执行 `020 down`。先恢复数据库/Storage 备份或确认新 owner/preset 字段可安全舍弃，再人工回滚；现有 private signed URL 在有效期内不受 preset 变化影响，public 开关关闭后下一次未缓存请求应被拒绝，旧公开缓存最多保留 5 分钟。

#### 项目成员授权 / 迁移 022 部署门禁

包含项目成员 RBAC 的版本必须先应用 `022_project_members`，再启动新 API/Admin。该版本会把平台 `admin` 收紧为仅可登录身份，项目访问必须来自数据库当前 `super_admin`、workspace owner 或显式项目成员关系；不能在 migration 仍为 021 时先替换 API。

1. 升级前完成数据库备份，并用 `pg_restore -l` 验证 custom archive 可读。
2. 先执行以下只读查询审计 schema 是否被多个项目占用，正常结果必须为零行。授权解析会对歧义 schema 失败关闭；项目与环境创建也会拒绝使用已分配或物理存在的 schema，但历史冲突仍需在发布前人工修复。

```sql
WITH schema_projects AS (
  SELECT schema_name, project_id
  FROM druvia_projects
  WHERE schema_name IS NOT NULL
  UNION
  SELECT schema_name, project_id
  FROM druvia_project_environments
)
SELECT schema_name,
       COUNT(DISTINCT project_id) AS project_count,
       array_agg(DISTINCT project_id ORDER BY project_id) AS project_ids
FROM schema_projects
GROUP BY schema_name
HAVING COUNT(DISTINCT project_id) > 1
ORDER BY schema_name;
```

3. 再审计历史 backup scope，正常结果必须为零行。任何结果都先隔离并核对实际 dump 归属；新 API 会从列表中过滤不一致或歧义记录，并以 `BACKUP_SCOPE_MISMATCH` 拒绝详情读取、下载、删除和恢复。

```sql
WITH schema_projects AS (
  SELECT p.schema_name, p.project_id, p.tenant_id
  FROM druvia_projects p
  WHERE p.schema_name IS NOT NULL
  UNION
  SELECT e.schema_name, p.project_id, p.tenant_id
  FROM druvia_project_environments e
  JOIN druvia_projects p ON p.project_id = e.project_id
),
backup_scopes AS (
  SELECT b.backup_id,
         b.tenant_id AS backup_tenant_id,
         b.project_id AS backup_project_id,
         b.schema_name,
         COUNT(DISTINCT scope.project_id) AS schema_project_count,
         MIN(scope.project_id) AS schema_project_id,
         MIN(scope.tenant_id) AS schema_tenant_id
  FROM druvia_backups b
  LEFT JOIN schema_projects scope ON scope.schema_name = b.schema_name
  GROUP BY b.backup_id, b.tenant_id, b.project_id, b.schema_name
)
SELECT *
FROM backup_scopes
WHERE schema_project_count <> 1
   OR schema_tenant_id <> backup_tenant_id
   OR (backup_project_id IS NOT NULL AND backup_project_id <> schema_project_id)
ORDER BY backup_id;
```

4. 执行 `pnpm migrate status`，确认当前数据库与 manifest 的 `migration.from/to` 匹配。
5. 执行 `pnpm migrate up`，确认 `druvia_schema_versions` 当前版本为 22，并检查 `druvia_project_members` 的角色约束、唯一约束、索引和触发器均存在。
6. 启动 API/Admin 后，以 owner 验证原项目全权限；以普通无成员 `admin` 验证已知 Project ID/schema 仍返回 403。
7. 通过成员 API 创建初始授权，不手写成员表 SQL；分别验证成员本项目 capability、跨项目拒绝和 owner-only 凭证/成员管理拒绝。
8. GHCR 与自建 Registry manifest 必须都声明 `required=true`、`to=22`、`requiresBackup=true`、`reversible=false`，并引用同一次构建对应的镜像 digest。

`022 down` 只允许成员表为空时执行；存在任何成员关系会以 SQLSTATE `55006` 拒绝回滚。需要回退旧 API 时，先评估移除成员对管理访问的影响并导出成员清单；不得为了镜像回滚自动删除成员或自动执行 down migration。

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
- 从 Batch 3A 回滚代码时保留迁移 `018`；旧 API 会忽略附加列，自动执行 down 反而会丢失 explicit 项目清单
- 回滚到 Batch 3A 之前的 API 会恢复平台 token GraphQL 通道，并把 explicit 项目按旧 `user` role 执行，不属于透明降级
- 启动旧 API 前应在 ingress 阻断 `/api/v1/projects/:projectId/graphql`，或使用保留平台 token 拒绝逻辑的应急构建
- `018` down 仅用于受控开发重置或永久移除功能；执行前必须停止项目创建并导出所有项目的 `data_access_mode`
- `019` down 仅用于受控开发重置或永久移除迁移控制面；存在 applying、rolling_back、applied 或 recovery-required 记录时会拒绝执行，OTA 不得自动 down

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
| 待发布 | 000-020 | Project Data Access Batch 4 与 Storage Project User actor cutover |

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

*Last Updated: 2026-08-19*
