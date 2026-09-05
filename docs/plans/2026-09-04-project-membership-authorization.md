# 项目成员与角色授权设计及实施方案

状态：本地实施与验证已完成，生产发布/OTA 尚未执行
Owner：Druvia Platform Authorization
日期：2026-09-04

## 1. 背景

Druvia 当前按“单租户 + 多项目”运行。平台用户只有 `super_admin` 与 `admin` 两种角色；workspace 通过 `druvia_tenants.owner_uid` 表示唯一 owner，项目本身没有成员关系。`admin` 只是可登录控制台的普通平台账号，不应自动获得任意项目权限。

现有访问助手只把 workspace owner 视为项目和 schema 的授权主体。这使 PITCHETCH 无法在保留 `Default Tenant` 与 Taro 项目隔离的前提下，把数据库和数据表管理权授予 `pitchetch@druvia.site`。同时，部分 tenant、project、SQL、DDL、数据库凭证和 backup 路由目前只有认证校验，缺少资源归属校验，普通平台账号可能绕过界面直接访问其他项目。

本功能在不提前实现完整多租户成员体系的前提下，增加项目级成员和固定角色，并统一收紧项目资源授权。它属于平台管理身份边界，不改变 Project User、项目 API Key、Trusted Backend Key 或 Hasura 应用 actor 的语义。

## 2. 目标与非目标

### 2.1 目标

1. 允许 workspace owner 把现有平台用户加入指定项目。
2. 提供 `project_admin`、`database_admin`、`viewer` 三种固定项目角色。
3. 让 `pitchetch@druvia.site` 仅管理 PITCHETCH 的数据库、数据表、数据、Hasura metadata、数据访问策略和 Realtime 表配置。
4. 保留 workspace owner 对旗下项目的隐式 owner 权限，并为 `super_admin` 提供可审计的全局管理覆盖。
5. 普通平台 `admin` 不因平台角色自动获得任何项目权限。
6. 所有项目、schema、tenant 和 backup 管理路由统一执行资源级授权，修复已知 Project ID、schema 名或 backup ID 可被越权使用的问题。
7. 保持现有项目、业务 schema、Project Session、API Key、Trusted Backend Key 和应用 SDK 兼容。
8. 为未来 `tenant_members` 多租户成员模型保留直接扩展路径。

### 2.2 非目标

- 不在本批次实现完整多租户、多 workspace 成员或邀请系统。
- 不提供自定义角色、逐项勾选权限或 deny override。
- 不允许 `project_admin` 继续授权其他成员。
- 不把项目成员转换为 Project User，也不允许平台 session 访问应用 GraphQL 或 Realtime。
- 不改变 PostgreSQL 项目数据库用户的授权模型。
- 不转移 `Default Tenant` owner，不移动或重建 PITCHETCH 项目。
- 不修改 `dru_default_taroapp` 或 `dru_default_pitchetch` 业务表。

## 3. 方案比较与决策

### 3.1 每项目独立 workspace

把 PITCHETCH 移入由 `pitchetch` 用户拥有的新 workspace，可以复用现有 owner 校验，但会把项目错误建模为租户，并使后续多人协作再次遇到相同问题。项目转移还会影响 tenant 语义、存储路径、备份和环境命名。

结论：拒绝。

### 3.2 在项目表增加单一 owner

`project_owner_uid` 可以满足一个项目一个负责人的短期需求，但不能表示多人协作和只读访问，未来仍需迁移为成员表，并产生 tenant owner 与 project owner 的冲突规则。

结论：拒绝。

### 3.3 项目成员表与固定角色

新增 `druvia_project_members`，workspace owner 保持隐式 owner；普通平台用户通过项目成员关系取得固定角色。未来多租户阶段可以增加 `tenant_members`，不需要重写项目成员模型。

结论：采用。

## 4. 身份与权限边界

### 4.1 平台、workspace 与项目角色

```text
Platform role
  super_admin  全局运维、系统设置、OTA、平台用户管理和应急覆盖
  admin        普通控制台账号，本身不授予项目权限

Workspace relation
  owner_uid    workspace owner，对旗下项目具有隐式 owner 权限

Project relation
  project_admin
  database_admin
  viewer
```

平台 `admin` 是当前最低控制台身份，名称保留以兼容数据库、JWT 和 Admin。它不能被解释为全局管理员。

### 4.2 授权解析顺序

项目授权必须由统一服务解析，顺序固定为：

1. 已认证身份必须是 `platform_user`；Project User 和 API Key 不能进入管理授权。
2. 使用 JWT 的 `uid` 与 `userId` 联合查询平台用户，数据库当前状态必须为 `active`；数据库当前角色为 `super_admin` 时获得有效角色 `owner`。不得只信任 JWT 中可能过期的 role。
3. 项目所属 workspace 的 `owner_uid` 与当前平台用户匹配时，获得有效角色 `owner`。
4. 查询 `(project_id, user_uid)` 对应的项目成员角色。
5. 没有匹配关系时返回 `403 FORBIDDEN`。

不存在的项目返回 `404`。对于无权访问的调用，列表接口必须过滤资源，详情接口不得泄露 schema、凭证或其他敏感内容。

### 4.3 固定 capability

代码不直接散落角色比较，而是把有效角色映射为固定 capability：

- `project:read`
- `project:update`
- `project:delete`
- `members:read`
- `members:manage`
- `database:read`
- `database:write`
- `database:credentials`
- `data_access:manage`
- `auth:manage`
- `api_keys:manage`
- `trusted_keys:manage`
- `storage:manage`
- `functions:manage`
- `realtime:manage`
- `environments:manage`
- `backups:read`
- `backups:create`
- `backups:restore`

角色与 capability 的映射在一个模块中定义，路由只声明所需 capability。

## 5. 权限矩阵

| 能力 | Owner / Super Admin | Project Admin | Database Admin | Viewer |
| --- | --- | --- | --- | --- |
| 查看项目 | 允许 | 允许 | 允许 | 允许 |
| 修改项目配置 | 允许 | 允许 | 拒绝 | 拒绝 |
| 查看表结构和数据 | 允许 | 允许 | 允许 | 允许 |
| 修改表结构和数据 | 允许 | 允许 | 允许 | 拒绝 |
| SQL 查询 | 允许 | 允许 | 允许 | 仅只读查询 |
| SQL 导入和 DDL/DML | 允许 | 允许 | 允许 | 拒绝 |
| 数据导出 | 允许 | 允许 | 允许 | 允许 |
| Hasura metadata 和数据访问策略 | 允许 | 允许 | 允许 | 拒绝 |
| Realtime 表配置 | 允许 | 允许 | 允许 | 拒绝 |
| Auth、Storage、Functions | 允许 | 允许 | 拒绝 | 拒绝 |
| 项目环境管理 | 允许 | 允许 | 拒绝 | 拒绝 |
| API Key | 允许 | 允许 | 拒绝 | 拒绝 |
| Trusted Backend Key | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 数据库连接凭证 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 创建和下载备份 | 允许 | 允许 | 允许 | 拒绝 |
| 恢复或删除备份 | 允许 | 允许 | 拒绝 | 拒绝 |
| 查看项目成员 | 允许 | 允许 | 允许 | 允许 |
| 管理项目成员 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 删除或转移项目 | 允许 | 拒绝 | 拒绝 | 拒绝 |

Trusted Backend Key 与数据库连接凭证保持 owner-only，因为两者可以绕过大部分应用层授权。项目删除和成员管理同样保持 owner-only，防止成员自行扩权或造成不可恢复的数据删除。

## 6. 数据模型

新增 migration `022_project_members`：

```sql
CREATE TABLE druvia_project_members (
  id BIGSERIAL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  user_uid INTEGER NOT NULL
    REFERENCES druvia_users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL,
  created_by INTEGER
    REFERENCES druvia_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT druvia_project_members_role_check
    CHECK (role IN ('project_admin', 'database_admin', 'viewer')),
  CONSTRAINT druvia_project_members_project_user_key
    UNIQUE (project_id, user_uid)
);

CREATE INDEX idx_druvia_project_members_user
  ON druvia_project_members(user_uid, project_id);
```

规则：

- workspace owner 不写入成员表，避免出现两个 owner 事实源。
- 不能为 workspace owner 创建冗余成员记录。
- 只能添加 `active` 的平台用户。
- 项目授权查询必须联表确认当前平台用户仍为 `active`；用户停用后其旧 JWT 即使仍在 TTL 内，项目授权也必须拒绝。该检查位于统一项目授权服务，不要求无关的公开或应用数据请求额外查询平台用户。
- `super_admin` 判断同样读取数据库当前角色；用户被降权后，旧 JWT 不得继续取得项目覆盖、平台设置、用户管理、Dashboard 或 OTA 权限。
- 删除平台用户时成员记录级联删除；现有平台用户删除仍保持 `super_admin` 控制。
- 更新成员角色和删除成员必须在事务中重新验证操作者仍是 owner/super_admin。
- `updated_at` 使用现有通用更新时间触发器模式。

## 7. 管理 API

新增项目成员路由：

```http
GET    /api/v1/projects/:projectId/access
GET    /api/v1/projects/:projectId/members
GET    /api/v1/projects/:projectId/member-candidates?q=<email-or-username>
POST   /api/v1/projects/:projectId/members
PATCH  /api/v1/projects/:projectId/members/:userId
DELETE /api/v1/projects/:projectId/members/:userId
```

`access` 返回服务端计算的有效角色、capability、`isWorkspaceOwner` 和 `isSuperAdmin`，供 Admin 控制导航与操作；客户端不能提交或覆盖这些字段。`member-candidates` 仅允许 owner/super_admin 使用，查询词至少 2 个字符、最多返回 10 个 active 平台用户，并排除 workspace owner 和已有成员，避免依赖或开放全局用户列表。

创建请求：

```json
{
  "userId": "user_vqEYfhkAHyk-1lR4",
  "role": "database_admin"
}
```

更新请求：

```json
{
  "role": "viewer"
}
```

成员响应只返回平台用户的 `userId`、用户名、邮箱、状态、项目角色和创建时间，不返回密码、token 或其他平台敏感字段。

错误契约：

- `400 INVALID_ROLE`：未知项目角色。
- `400 OWNER_MEMBERSHIP_NOT_ALLOWED`：尝试把 workspace owner 写入成员表。
- `404 PROJECT_NOT_FOUND`：项目不存在。
- `404 USER_NOT_FOUND`：平台用户不存在。
- `409 USER_INACTIVE`：目标用户不是 active。
- `409 MEMBER_EXISTS`：成员已存在。
- `403 FORBIDDEN`：操作者缺少成员读取或管理 capability。

只有 owner/super_admin 可以新增、改角色和移除成员。所有已授权项目角色可以查看成员列表，但不能从该列表获取任何凭证。

## 8. 现有路由授权收敛

### 8.1 Tenant 与项目发现

- `GET /tenants` 只返回当前用户拥有 workspace，或至少包含一个可访问项目的 workspace；`super_admin` 可查看全部。
- `GET /tenants/:tenantId` 对 owner 返回完整信息，对仅有项目成员关系的用户返回导航所需的安全字段。
- tenant 创建后当前用户成为 owner。
- Hasura `createTenant` Action 必须验证转发的 Platform Bearer Token，并要求 token 的 `userId` 与 action `x-hasura-user-id` 完全一致；不得只信任可伪造的请求体 session variables。`me` Action 使用同一一致性校验。
- tenant 更新和删除仅 owner/super_admin。
- `GET /tenants/:tenantId/projects` 只返回当前用户可访问的项目；owner/super_admin 返回全部。
- 项目创建仅 tenant owner/super_admin。

### 8.2 项目与 schema

- 项目详情需要 `project:read`。
- 项目更新需要 `project:update`。
- 项目删除需要 `project:delete`。
- schema 参数先解析到唯一的项目或项目环境，再检查对应 capability；不得只依赖 schema 命名格式。
- 表结构写入、行数据写入、SQL import、DDL/DML 需要 `database:write`。
- 查询和导出需要 `database:read`。
- 数据库用户创建、重置、删除和连接信息需要 `database:credentials`。

### 8.3 项目模块

- Auth、API Key、Storage 和 Functions 使用各自 `*:manage` capability。
- Trusted Backend Key 使用 `trusted_keys:manage`，固定 owner-only。
- Realtime token exchange 继续只接受 Project User/API Key；管理配置使用 `realtime:manage`。
- RPC 的 Platform User 管理调用必须要求项目访问，应用调用继续使用原 Project Actor 契约。
- 数据访问迁移和 Hasura permission 写入需要 `data_access:manage`。
- 环境写入需要 `environments:manage`。

### 8.4 备份

backup ID 必须先解析到项目或 tenant，再执行 capability 校验：

- 列表按可访问资源过滤。
- 创建和下载项目备份需要 `backups:create` / `backups:read`。
- 恢复和删除需要 `backups:restore`。
- tenant 级全量备份保持 owner/super_admin，项目成员不能借 tenant backup 读取其他项目。

### 8.5 平台用户管理

- `/users/me` 继续允许当前平台用户管理自己的资料和密码。
- 全局用户列表、用户详情、状态修改、创建、更新、删除和密码重置只允许 `super_admin`。
- workspace owner 只能通过项目级 `member-candidates` 搜索必要的 active 用户安全字段，不能借成员管理读取完整平台用户目录。

### 8.6 Dashboard、OpenAPI 与遗留租户资源

- 全局 `/dashboard/*` 聚合、活动与资源使用量只允许 `super_admin`，普通平台账号不得读取跨 workspace 统计。
- tenant dashboard 对 owner/super_admin 返回 workspace 全量聚合；仅有项目成员关系的用户只能取得其可访问项目的项目列表、聚合指标和已过滤 timeline，不得泄露其他项目名称、健康状态、活动或用量。
- 项目 OpenAPI 文档属于管理面数据库元数据读取，要求 `database:read`。
- 旧 `druvia_files` 接口是 tenant 级遗留存储接口，可同时包含无 `project_id` 文件，无法安全映射为项目 capability；本批次统一限制为 tenant owner/super_admin。项目成员继续使用已完成 Project User cutover 的项目 Storage API。
- 平台设置读取与写入均只允许 `super_admin`；系统更新接口继续保持 `super_admin` 边界。

### 8.7 明确不进入管理 RBAC 的应用身份链路

- `/projects/:projectId/graphql` 继续只接受同项目 Project User/API Key，平台项目成员不能借管理权限调用应用 GraphQL。
- Project Auth 的登录、silent login、refresh、logout、Apple 用户撤销与 Apple notification 保持现有 Project User/provider 校验。
- Apple identity/lifecycle 管理端点的 platform user 分支要求 `auth:manage`；同一 lifecycle endpoint 的 Trusted Backend Key 分支继续要求既有 `project_auth_lifecycle:manage` scope，不转换为平台成员身份。
- Realtime token exchange、Storage trusted ticket、Functions 内部 GraphQL/Storage 和应用 RPC 继续执行各自的 Project Actor 或 Trusted Backend Key 契约。
- tenant OAuth authorize/callback 及当前用户 provider bind/list/unbind 属于平台登录与个人身份绑定，不从项目成员关系派生权限；本功能只增加回归测试防止误套项目 capability。

## 9. Admin UI

在项目设置下增加“项目成员”页面：

- 路径：`/t/:tenantId/p/:projectId/settings/members`。
- workspace owner 置顶展示为“所有者”，不可编辑。
- 成员列表展示用户名、邮箱、状态、项目角色和加入时间。
- owner/super_admin 可打开新增成员对话框，通过现有平台用户邮箱或用户名选择 active 用户。
- 角色使用固定下拉选择，不展示底层 capability 名称。
- 角色修改与移除需要确认；不能修改 owner。
- 非 owner 只读查看成员列表，不显示新增、改角色和移除操作。
- 导航、页面和按钮按 capability 控制可见性，但 API 授权是最终边界。
- 对 `database_admin` 隐藏 Auth、API Keys、Trusted Keys、Storage、Functions、数据库凭证和项目删除入口。
- 对 `viewer` 隐藏所有写操作，并保证直接访问写页面时显示无权限状态。

## 10. PITCHETCH 初始授权

完成 migration、API 和 Admin 部署后，由 `Default Tenant` owner 把现有 active 平台用户加入项目：

```text
project_id = proj_YlWn_0Yswm3TLPww
user_id   = user_vqEYfhkAHyk-1lR4
email     = pitchetch@druvia.site
role      = database_admin
```

预期结果：该用户可管理 `dru_default_pitchetch` 的表结构、表数据、SQL、Hasura metadata、数据访问策略和 Realtime 表配置，但不能访问 Taro 项目，也不能管理 PITCHETCH 的成员、Trusted Backend Key、数据库连接凭证或删除项目。

## 11. 兼容、迁移与发布

- migration `022` 只新增平台表、索引和触发器，不写入项目业务 schema。
- 现有 workspace owner 无需数据回填，升级后保持现有项目权限。
- 普通平台 `admin` 的 JWT 结构不变；授权在每次管理请求中按数据库关系解析。
- Project Session、API Key、Hasura scoped role、SDK 和 taro-app 应用数据路径不变。
- 包含新授权代码的 API/Admin 启动前必须应用 migration `022`。
- release workflow、双 Registry manifest、发布指南和契约测试的 migration ceiling 从 `21` 提升到 `22`。
- migration `022` 可回滚的前提是成员表为空；down migration 遇到成员数据必须拒绝，避免静默丢失授权关系。
- 本功能完成不自动发布生产；进入 stable release 前仍需 taro-app 管理回归、本地 release 演练和生产同构验证。

## 12. 安全与错误处理

- 不接受客户端声明的角色或 capability；只信任平台 JWT 身份和数据库授权关系。
- 不允许 Project User、API Key 或 Trusted Backend Key 调用项目成员管理接口。
- 资源权限不足统一返回 `403`；敏感详情可以按既有防枚举策略返回 `404`。
- 所有成员新增、角色变更、移除以及 super_admin 覆盖写入结构化审计日志，记录操作者、项目、目标用户、前后角色和 request ID，不记录 token。
- 成员变更立即影响新请求，不缓存长期授权结果。
- 数据访问迁移期间的既有写锁继续生效；新增角色授权不得绕过 migration lock。
- 前端隐藏不视为授权措施，所有写路由必须有后端 capability 测试。

## 13. 测试与验收

### 13.1 授权单元测试

- super_admin、workspace owner、三个成员角色和无成员用户解析为预期有效角色。
- 停用用户、跨项目成员、Project User 和 API Key 被拒绝。
- capability 矩阵与本设计表格一致。
- workspace owner 不能被重复添加为成员。

### 13.2 API 测试

- owner 可以新增、改角色和移除成员。
- 项目角色只能读取成员，所有成员写入返回 `403`。
- PITCHETCH `database_admin` 可以访问其表、数据、SQL、Hasura 和 Realtime 管理接口。
- 同一用户访问 Taro Project ID、schema、backup 和数据库凭证均被拒绝。
- viewer 的所有写操作返回 `403`，只读查询和导出成功。
- project_admin 不能管理成员、Trusted Backend Key、数据库凭证或删除项目。
- 无成员普通 admin 即使知道 Project ID、schema 或 backup ID 也不能读取或修改。
- tenant/project 列表只返回可访问资源。

### 13.3 回归与发布验证

- workspace owner 现有 Admin 工作流保持可用。
- taro-app 的 Project Auth、GraphQL、Realtime、Storage、RPC 和 Functions 应用路径不变。
- migration `022` up/down 守卫、migration runner 和 release manifest 契约测试通过。
- API、Admin build、lint 和相关测试通过；若根级门禁仍有既有失败，必须记录并证明与本功能无关。

## 14. 实施状态

设计、代码、migration、Admin UI、本地数据授权和直接 review 已完成。普通 PostgreSQL 与活动 PostGIS 数据库均已应用 migration `022`；PITCHETCH 初始成员只写入当前 API 使用的 PostGIS 数据库。生产发布、预发布同构演练和 OTA 仍是独立后续任务。

## 15. 实施记录

> 以下清单由原实施计划更新为执行记录。`[x]` 表示对应行为和验收结果已经完成；实际测试按模块合并到既有 controller、路由和 UI 契约测试时，不要求保留计划阶段设想的独立测试文件名。生产发布、预发布同构演练和 OTA 不在本记录的完成范围内。

**目标：** 建立项目成员固定角色，统一项目管理 capability，并把 `pitchetch@druvia.site` 安全授权为 PITCHETCH `database_admin`。

**架构：** `packages/shared` 定义公开角色与 access DTO；API 授权核心把平台用户、workspace owner 和项目成员解析为有效角色/capability；各管理路由只声明 capability。Admin 每次进入项目时从服务端读取 access DTO，成员页只调用项目级成员 API。

**技术栈：** PostgreSQL 17 migration、Fastify 5、TypeScript、Vitest、Next.js 16、React 19、Zustand、pnpm、Docker Compose。

### Task 1：Migration 022 与共享契约

**文件：**

- 新增：`migrations/022_project_members.up.sql`
- 新增：`migrations/022_project_members.down.sql`
- 新增：`packages/shared/src/types/project-members.ts`
- 修改：`packages/shared/src/index.ts`
- 新增测试：`tests/unit/project-members-schema.test.ts`

- [x] 先编写 migration 契约测试，读取 up/down SQL 并断言：外键、唯一约束、三个角色 check、用户索引、更新时间触发器，以及 down 在成员表非空时抛出 `55006`。
- [x] 运行 `pnpm vitest run tests/unit/project-members-schema.test.ts`，确认因 migration 文件不存在而失败。
- [x] 实现 up migration。复用 `druvia_update_updated_at()`，核心结构与第 6 节一致，并创建 `druvia_project_members_updated_at` trigger。
- [x] 实现防丢失 down migration：

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM druvia_project_members LIMIT 1) THEN
    RAISE EXCEPTION 'cannot drop non-empty druvia_project_members'
      USING ERRCODE = '55006';
  END IF;
END $$;

DROP TRIGGER IF EXISTS druvia_project_members_updated_at
  ON druvia_project_members;
DROP TABLE druvia_project_members;
```

- [x] 在共享包定义并导出以下稳定契约：

```ts
export type ProjectMemberRole = 'project_admin' | 'database_admin' | 'viewer'
export type ProjectEffectiveRole = 'owner' | ProjectMemberRole

export type ProjectCapability =
  | 'project:read' | 'project:update' | 'project:delete'
  | 'members:read' | 'members:manage'
  | 'database:read' | 'database:write' | 'database:credentials'
  | 'data_access:manage' | 'auth:manage' | 'api_keys:manage'
  | 'trusted_keys:manage' | 'storage:manage' | 'functions:manage'
  | 'realtime:manage' | 'environments:manage'
  | 'backups:read' | 'backups:create' | 'backups:restore'

export interface ProjectAccess {
  projectId: string
  role: ProjectEffectiveRole
  capabilities: ProjectCapability[]
  isWorkspaceOwner: boolean
  isSuperAdmin: boolean
}
```

- [x] 重新运行 migration 契约测试和 `pnpm --filter @druvia/shared build`，确认通过。

### Task 2：统一项目授权核心

**文件：**

- 新增：`apps/api/src/lib/project-authorization.ts`
- 修改：`apps/api/src/lib/access.ts`
- 修改：`apps/api/src/middleware/auth.ts`
- 新增测试：`tests/unit/project-authorization.test.ts`
- 修改测试：`tests/unit/api-app.test.ts`

- [x] 先写角色解析与 capability 矩阵测试，覆盖数据库当前角色为 `super_admin`、workspace owner、三个成员角色、无成员、inactive 用户、跨项目、Project User 和 API Key；另覆盖 JWT 声明为 super_admin 但数据库已降权，以及 JWT `uid`/`userId` 不匹配。
- [x] 运行 `pnpm vitest run tests/unit/project-authorization.test.ts`，确认缺少授权模块而失败。
- [x] 实现唯一角色映射。固定集合如下，不允许调用方传入自定义 capability：

```ts
const ROLE_CAPABILITIES: Record<ProjectEffectiveRole, readonly ProjectCapability[]> = {
  owner: ALL_PROJECT_CAPABILITIES,
  project_admin: [
    'project:read', 'project:update', 'members:read',
    'database:read', 'database:write', 'data_access:manage',
    'auth:manage', 'api_keys:manage', 'storage:manage',
    'functions:manage', 'realtime:manage', 'environments:manage',
    'backups:read', 'backups:create', 'backups:restore',
  ],
  database_admin: [
    'project:read', 'members:read', 'database:read', 'database:write',
    'data_access:manage', 'realtime:manage', 'backups:read', 'backups:create',
  ],
  viewer: ['project:read', 'members:read', 'database:read'],
}
```

- [x] 实现 `resolveProjectAccess(user, projectId)`：使用 JWT 的数字 `uid` 和公开 `userId` 联合匹配，单次查询联结 project、tenant owner、当前 `druvia_users.status`、当前数据库 role 和 member；先确认 identity 一致且 active，再按数据库 super_admin、owner、member 顺序返回 `ProjectAccess | null`。
- [x] 实现 `requireProjectCapability(capability)` Fastify preHandler factory，以及 service/controller 可调用的 `assertProjectCapability()`。非 platform identity 返回 `401`，项目存在但无权返回 `403`。
- [x] 实现共享 `requireSuperAdmin` guard，同样实时检查平台用户 identity、active 状态和数据库当前 role；后续平台级敏感路由不得直接比较 JWT `request.user.role`。
- [x] 实现 `resolveSchemaProject(schemaName)` 和 `requireSchemaCapability(capability)`，通过项目主 schema 或 environment schema 解析 project，不依赖 schema 字符串格式。
- [x] 将旧 `checkProjectAccess` / `checkSchemaAccess` 暂时包装到新 resolver，保持尚未迁移模块和既有测试兼容；所有路由收敛完成后只保留明确标记的兼容 wrapper。
- [x] 运行授权测试与 `tests/unit/api-app.test.ts`，确认通过。

### Task 3：项目成员服务、API 与审计

**文件：**

- 新增：`apps/api/src/modules/project-members/project-members.service.ts`
- 新增：`apps/api/src/modules/project-members/project-members.controller.ts`
- 新增：`apps/api/src/modules/project-members/project-members.routes.ts`
- 修改：`apps/api/src/index.ts`
- 修改：`apps/api/src/modules/activity/activity.service.ts`
- 新增测试：`tests/unit/project-members.service.test.ts`
- 新增测试：`tests/unit/project-members.controller.test.ts`
- 修改测试：`tests/unit/api-app.test.ts`

- [x] 先写 service 测试：成员列表含隐式 owner；候选用户只返回 active、排除 owner/已有成员、限制 10 条；新增重复成员、inactive 用户和 owner 成员分别产生稳定错误；更新和删除限定 project/user 复合条件。
- [x] 写 controller 测试：所有角色可读取 `access` 和成员列表；只有 owner/super_admin 可搜索候选、创建、修改和删除；非 platform identity 返回 `401`。
- [x] 运行新增测试，确认因模块不存在而失败。
- [x] 实现 service DTO，只返回：

```ts
interface ProjectMemberView {
  userId: string
  email: string
  username: string | null
  status: 'active' | 'inactive' | 'suspended'
  role: 'owner' | ProjectMemberRole
  isWorkspaceOwner: boolean
  createdAt: string | null
}
```

- [x] 实现第 7 节六个 endpoint；候选搜索要求 `q.trim().length >= 2`，使用参数化 `ILIKE`，按精确邮箱优先、最多 10 条。
- [x] 对成员新增、角色变更和移除调用现有 `logActivity()`，action 固定为 `project_member.created`、`project_member.role_updated`、`project_member.removed`，details 只含 project ID、目标 user ID 和前后角色。
- [x] 注册路由并运行新增测试及 `tests/unit/api-app.test.ts`，确认通过。

### Task 4：Tenant、Project 与平台用户授权收敛

**文件：**

- 修改：`apps/api/src/modules/tenant/tenant.controller.ts`
- 修改：`apps/api/src/modules/tenant/tenant.service.ts`
- 修改：`apps/api/src/modules/project/project.controller.ts`
- 修改：`apps/api/src/modules/project/project.service.ts`
- 修改：`apps/api/src/modules/project/project.routes.ts`
- 修改：`apps/api/src/modules/user/user.controller.ts`
- 修改：`apps/api/src/modules/dashboard/dashboard.controller.ts`
- 修改：`apps/api/src/modules/dashboard/dashboard.service.ts`
- 修改：`apps/api/src/modules/settings/settings.controller.ts`
- 修改：`apps/api/src/modules/system-update/system-update.controller.ts`
- 修改：`apps/api/src/modules/actions/actions.routes.ts`
- 修改：`apps/api/src/modules/actions/actions.controller.ts`
- 新增测试：`tests/unit/tenant-authorization.test.ts`
- 修改测试：`tests/unit/project-controller.test.ts`
- 新增测试：`tests/unit/platform-user-authorization.test.ts`
- 新增测试：`tests/unit/dashboard-authorization.test.ts`
- 修改测试：`tests/integration/actions.test.ts`

- [x] 先写失败测试，证明普通 admin 不能列出无成员 workspace/project、不能按已知 ID 读取或更新、不能在他人 tenant 创建项目；super_admin、owner 和项目成员只得到矩阵允许的资源。
- [x] 写平台用户测试，证明 `/users/me` 保持可用，而 list/get/status/create/update/delete/reset-password 全部要求数据库当前角色为 super_admin；旧 JWT 中残留的 super_admin role 在降权后返回 `403`。
- [x] 写 Dashboard 与 settings 测试：全局统计、趋势、活动、资源和平台 settings 读取仅 super_admin；tenant owner 看全量 tenant dashboard，项目成员只看到其项目对应的聚合、项目行和 timeline。
- [x] 写 Hasura Action 失败测试：直连伪造 `x-hasura-user-id`、缺少 Bearer Token、Project User/API Key，以及 token userId 与 session variable 不一致均不能调用 `me` 或 `createTenant`；有效且一致的 Platform Token 保持可用。
- [x] 运行上述测试确认 RED。
- [x] 为 tenant service 增加 `listAccessibleTenants(uid, role)` 和安全详情投影；owner/super_admin 取得完整 tenant，项目成员只取得导航字段。
- [x] 为 project service 增加 `listAccessibleProjects(tenantId, uid, role)`；普通成员查询必须 join `druvia_project_members`，不得先取全量后在内存过滤。
- [x] 在 project routes 为 get、update、delete、query、ddl 和 db credentials 分别声明 capability；创建项目先要求 tenant owner/super_admin。
- [x] 收紧全局用户管理 controller；成员候选搜索只走 Task 3 的项目级 endpoint。
- [x] tenant dashboard 的过滤条件必须下推到 SQL/service 查询；overview、project health 和 timeline 共用可访问 Project ID 集合，不得先返回全量数据再仅在前端隐藏。
- [x] 平台 settings GET/PATCH、全局 dashboard、system update/rollback/restart 和平台用户管理统一使用 `requireSuperAdmin` guard；删除直接比较 JWT role 的授权分支，保留 `/users/me` 和项目成员导航可用。
- [x] `actions/register` 与 `actions/login` 保持公开；`actions/me` 与 `actions/create-tenant` 增加 `authenticate`，controller 再验证 platform identity 和 Hasura session variable 一致性。
- [x] 运行本 Task 测试和现有 project/user/tenant 测试，确认通过。

### Task 5：Schema、表、数据、SQL 与数据库凭证授权

**文件：**

- 修改：`apps/api/src/modules/table/table.routes.ts`
- 修改：`apps/api/src/modules/table/import.routes.ts`
- 修改：`apps/api/src/modules/data/data.routes.ts`
- 修改：`apps/api/src/modules/sql/sql.controller.ts`
- 修改：`apps/api/src/modules/sql/sql.routes.ts`
- 修改：`apps/api/src/modules/project/project.controller.ts`
- 新增测试：`tests/unit/schema-capability-authorization.test.ts`
- 新增测试：`tests/unit/sql-authorization.test.ts`
- 修改测试：`tests/unit/project-controller.test.ts`

- [x] 先写失败测试：viewer 可 list/get/export/select，但不能 create/update/delete/import/DDL；database_admin 可写 PITCHETCH schema；同一用户访问 Taro schema 或 Project ID 返回 `403`。
- [x] 明确 table/data route capability：GET 元数据、关系、表、行和 export 使用 `database:read`；POST/PATCH/DELETE、metadata sync/track/reload 和 import 使用 `database:write`。
- [x] 将 schema 路由从全局 `verifySchemaAccess` hook 改为逐路由 `requireSchemaCapability()`，避免 GET/写操作共享同一布尔权限。
- [x] SQL export 和只读 query 使用 `database:read`；SQL import 与 `/ddl` 使用 `database:write`。继续保留现有 SQL 黑名单和 data-access mutation lock，不以 RBAC 替代 SQL 安全检查。
- [x] 项目数据库信息、创建用户、重置密码和删除用户统一要求 `database:credentials`。
- [x] 运行新增测试及 table/data/sql/project 相关测试，确认通过。

### Task 6：其余项目模块与备份授权

**文件：**

- 修改：`apps/api/src/modules/auth-admin/auth-admin.controller.ts`
- 修改：`apps/api/src/modules/api-keys/api-keys.routes.ts`
- 修改：`apps/api/src/modules/trusted-backend-keys/trusted-backend-keys.routes.ts`
- 修改：`apps/api/src/modules/storage/storage.controller.ts`
- 修改：`apps/api/src/modules/functions/functions.controller.ts`
- 修改：`apps/api/src/modules/realtime/realtime.controller.ts`
- 修改：`apps/api/src/modules/environment/environment.routes.ts`
- 修改：`apps/api/src/modules/data-access/data-access.controller.ts`
- 修改：`apps/api/src/modules/rpc/rpc.controller.ts`
- 修改：`apps/api/src/modules/backup/backup.controller.ts`
- 修改：`apps/api/src/modules/backup/backup.service.ts`
- 修改：`apps/api/src/modules/openapi/openapi.routes.ts`
- 修改：`apps/api/src/modules/project-auth/project-auth.controller.ts`
- 修改：`apps/api/src/modules/file/file.controller.ts`
- 修改：`apps/api/src/modules/file/file.service.ts`
- 新增测试：`tests/unit/project-module-capabilities.test.ts`
- 新增测试：`tests/unit/backup-authorization.test.ts`
- 新增测试：`tests/unit/legacy-file-authorization.test.ts`
- 修改现有相关 controller 测试。

- [x] 先用表驱动测试冻结模块映射：Auth=`auth:manage`，API Key=`api_keys:manage`，Trusted Key=`trusted_keys:manage`，Storage=`storage:manage`，Functions=`functions:manage`，Realtime 管理=`realtime:manage`，Environment=`environments:manage`，Data Access=`data_access:manage`，Platform RPC=`database:write`。
- [x] OpenAPI 文档要求 `database:read`；Apple identity 列表、retry revoke 和 platform lifecycle 管理分支要求 `auth:manage`。
- [x] 单独测试 Realtime token exchange、应用 GraphQL、Project Auth 登录/刷新/登出、Apple notification/用户撤销、Storage Project User/trusted ticket、Functions Project Actor 及 Trusted Backend Key lifecycle 路径保持原应用身份边界，不误用平台项目成员权限。
- [x] 为 tenant OAuth authorize/callback 和当前用户 provider bind/list/unbind 增加回归测试，确认它们保持平台登录/个人身份绑定语义，不因没有项目成员关系而失败。
- [x] 写遗留文件接口测试：tenant owner/super_admin 可按 tenant 或 file ID 操作 `druvia_files`；仅有项目成员关系的账号即使文件含同项目 `project_id` 也被拒绝；file ID 必须先解析 tenant 再授权。
- [x] 写 backup 测试：backup ID 先解析 project/tenant；列表在 SQL 层过滤；database_admin 只能创建/下载本项目备份；project_admin 可恢复/删除本项目备份；任何项目成员都不能操作 tenant 全量备份或其他项目备份。
- [x] 运行测试确认 RED，再把各模块私有的 `verifyProjectAccess` 替换为统一 capability guard。
- [x] 对 service 间内部调用保持显式 actor/capability，不依赖 controller 已验证的隐含假设；直接可导出的 service 写方法继续由其业务锁和 project scope 保护。
- [x] 运行新增测试以及 Auth、Storage、Functions、Realtime、RPC、Data Access、Environment、Backup 现有测试，确认通过。

### Task 7：Admin 项目 access 状态与成员管理 UI

**文件：**

- 修改：`apps/admin/src/lib/api.ts`
- 修改：`apps/admin/src/store/index.ts`
- 新增：`apps/admin/src/lib/project-access.ts`
- 新增：`apps/admin/src/hooks/use-project-access.ts`
- 修改：`apps/admin/src/app/t/[tenantId]/p/[projectId]/layout.tsx`
- 修改：`apps/admin/src/components/DashboardLayout.tsx`
- 修改：`apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/page.tsx`
- 新增：`apps/admin/src/app/t/[tenantId]/p/[projectId]/settings/members/page.tsx`
- 新增测试：`tests/unit/admin/project-access.test.ts`
- 新增测试：`tests/unit/admin/project-members.test.ts`

- [x] 先写纯函数测试，覆盖每种 capability 的菜单与操作可见性；不得直接用平台 `admin`/`super_admin` 猜测项目权限。
- [x] 为 API client 增加 access、members、candidate search、create/update/delete 方法，并复用 shared DTO。
- [x] 项目 layout 并行加载 project 与 access；access 不写入持久化 localStorage，切换项目或收到 `403` 时立即清空。
- [x] `project-access.ts` 只提供 `hasProjectCapability(access, capability)` 和菜单过滤；任何客户端判断都不替代 API 校验。
- [x] 在 DashboardLayout 和项目设置按 capability 隐藏无权限模块；viewer 页面保留只读入口，写控件禁用或不渲染。
- [x] 实现成员页面：owner 行置顶；候选搜索至少 2 字符；角色 select；新增使用 dialog；改角色和移除使用确认 dialog；异步状态固定尺寸并提供成功/错误反馈。
- [x] 使用 lucide 图标和现有 UI 组件，不引入新的组件库，不在卡片内嵌套卡片。
- [x] 运行 Admin 定向测试、本批次改动文件的定向 ESLint 和 `pnpm --filter @druvia/admin build`。

### Task 8：发布契约与长期文档同步

**文件：**

- 修改：`.github/workflows/release.yml`
- 修改：`tests/unit/release-pipeline.test.ts`
- 修改：`docs/003-version-release-guide.md`
- 修改：`docs/agent/design-decisions.md`
- 修改：`docs/agent/playbooks.md`
- 修改：`docs/progress.md`
- 修改：`AGENTS.md`
- 修改：`apps/api/AGENTS.md`
- 修改：本计划文档

- [x] 先更新 release pipeline 测试预期，使 migration ceiling 必须为 `22`，运行并确认旧 workflow 导致 RED。
- [x] 把 tag 与手动 release 的 migration 合同固定为 `required=true`、`to=22`、`requiresBackup=true`、`reversible=false`，移除可降级输入并由 manifest 生成器再次校验；GHCR 与自建 Registry manifest 继续共享相同 migration block。
- [x] 发布指南增加 migration `022` 前置检查、备份、up 验证和“成员表非空不得 down”回滚约束。
- [x] 长期决策记录平台角色、workspace owner、项目成员三层边界；playbook 记录成员授权、撤销和紧急恢复流程；progress 只在代码与验证完成后更新为已完成。
- [x] 根和 API AGENTS 增加常驻规则：平台 `admin` 不自动拥有项目权限，管理路由必须声明 capability，Project User/API Key 不得进入管理 RBAC。
- [x] 运行 `pnpm vitest run tests/unit/project-members-schema.test.ts tests/unit/release-pipeline.test.ts tests/unit/migration-runner-lock.test.ts`。

### Task 9：本地迁移、PITCHETCH 授权与完整验证

**文件：**

- 不新增生产代码；更新本计划的验证证据和最终状态。

- [x] 在修改本地数据库前备份活动 `druvia-postgres-postgis`，确认 API 的 `DB_HOST=postgres-postgis`。
- [x] 使用宿主端口先检查 migration：

```bash
DB_HOST=127.0.0.1 DB_PORT=5632 pnpm migrate status
```

- [x] 应用 migration `022`，再确认版本和表：

```bash
DB_HOST=127.0.0.1 DB_PORT=5632 pnpm migrate up
docker exec druvia-postgres-postgis psql -X -U postgres -d druvia \
  -c "SELECT version,name FROM druvia_schema_versions ORDER BY version DESC LIMIT 3;"
```

- [x] 通过成员 API 而非手写 SQL，把 `user_vqEYfhkAHyk-1lR4` 加入 `proj_YlWn_0Yswm3TLPww`，角色设为 `database_admin`。
- [x] 使用 `cloudio` owner 与 `pitchetch` 成员真实平台 session 验证：PITCHETCH 数据库管理成功、Taro 跨项目拒绝、owner-only 入口拒绝、owner 保持全权限；通用无成员和 inactive admin 路径由授权单测覆盖。
- [x] 执行定向全套测试：

```bash
pnpm vitest run \
  tests/unit/project-members-schema.test.ts \
  tests/unit/project-authorization.test.ts \
  tests/unit/project-members.service.test.ts \
  tests/unit/project-members.controller.test.ts \
  tests/unit/project-controller.test.ts \
  tests/unit/tenant-controller.test.ts \
  tests/unit/api-system-update.test.ts \
  tests/unit/functions-controller.test.ts \
  tests/unit/realtime-controller.test.ts \
  tests/unit/rpc-controller.test.ts \
  tests/unit/backup-authorization.test.ts \
  tests/unit/admin/project-access.test.ts \
  tests/unit/admin/project-members-ui.test.ts \
  tests/unit/admin/project-read-only-ui.test.ts \
  tests/unit/admin/sidebar-nav.test.ts \
  tests/unit/release-pipeline.test.ts \
  tests/unit/migration-runner-lock.test.ts
```

- [x] 在测试数据库环境单独执行 `pnpm vitest run tests/integration/actions.test.ts`，验证 Hasura Action 的 Bearer Token 与 session variable 一致性门禁。
- [x] 执行 `pnpm build`、`pnpm lint` 和 `pnpm test`。任何既有失败必须记录命令、失败用例和与本功能无关的证据；授权相关失败不得豁免。
- [x] 直接 review 当前全部改动，按严重性修复 findings 并重复测试，直到没有重要 findings。
- [x] 更新本文状态、实际变更文件、测试结果、本地 migration 和 PITCHETCH 成员授权证据；生产发布与 OTA 实测保持独立任务。

## 16. 实际交付与验证证据

### 16.1 交付结果

- migration `022`、共享角色/capability/access DTO、统一授权 resolver/guards、项目成员事务 API 与审计已经实现。
- tenant、project、schema、table/data、SQL、backup、Auth、API Key、Trusted Backend Key、Storage、Functions、Realtime、RPC、Environment、Data Access、OpenAPI、遗留文件、平台用户、settings、dashboard 和 system update 已按资源与 capability 收紧。
- Admin 每次进入项目读取服务端 access，按 capability 过滤项目菜单、设置入口和写控件；成员页支持搜索、添加、改角色和移除。项目或 schema 请求返回 `403` 时会清空当前 access 并触发重新校验。
- 项目 API 页面按 `database:read` 开放端点、GraphQL/REST 工具和 OpenAPI 文档；数据库直连信息及创建、重置、删除数据库用户只在 `database:credentials` 存在时加载和展示。
- workspace 备份页使用受资源过滤的 tenant backup endpoint，并逐项目读取服务端 access；创建、下载、恢复和删除控件分别按 `backups:create`、`backups:read`、`backups:restore` 显示，兼容 `/t/:tenantId/backups` 与旧 `/tenants/:tenantId/backups` 两条页面路径。
- viewer SQL 使用 PostgreSQL extended protocol 在 `BEGIN READ ONLY` 事务中执行，已阻止多语句和 writable CTE 绕过；该测试已加入 release 授权门禁。
- release workflow 不再允许手动覆盖 `required/to/requiresBackup/reversible`，tag 与手动发布及 GHCR/自建 Registry manifest 均固定 migration target `22`；manifest 生成器会拒绝不安全合同。

### 16.2 本地数据库与运行态

- migration 前已分别生成并校验 `docker/bak/druvia_postgis_pre_022_20260905_004256.dump` 与 `docker/bak/druvia_postgres_pre_022_20260905_004256.dump`。
- 活动 `druvia-postgres-postgis` 与备用 `druvia-postgres` 的 `max(druvia_schema_versions.version)` 均为 `22`。
- 已通过正式成员 API 在活动 PostGIS 库写入 `proj_YlWn_0Yswm3TLPww|25|database_admin`；备用普通 PostgreSQL 库保持 0 条成员关系。
- 已对活动 PostGIS 与备用普通 PostgreSQL 的 `druvia_backups` 执行 tenant/project/schema 历史 scope 审计，两库均为 0 条不一致记录。
- 已对两库的项目基础 schema 与环境 schema 执行多项目归属审计，两库均为 0 条歧义记录。
- `pitchetch` 真实 session 对 PITCHETCH access、成员读取、schema/table 读取和 SELECT 为 `200`；数据库凭证、成员写入、平台用户/settings/system update、Trusted Backend Key、Storage/Functions 管理及跨 Taro 项目为 `403`。`cloudio` owner/super_admin 的对应 owner 路径保持 `200`。

### 16.3 自动化验证

- `pnpm vitest run tests/unit tests/sdk tests/api`：152 个测试文件、1087 个用例全部通过。
- `pnpm vitest run tests/unit/project-authorization.test.ts tests/unit/backup-authorization.test.ts tests/unit/environment-service.test.ts`：3 个测试文件、20 个用例全部通过，覆盖 schema 多项目歧义 fail-closed、backup 拒绝歧义归属和环境 schema 冲突门禁。
- `pnpm vitest run tests/unit/admin/project-access.test.ts tests/unit/admin/project-api-page.test.tsx tests/unit/admin/tenant-backups-page.test.tsx`：3 个测试文件、10 个用例全部通过，覆盖 API 文档入口、数据库凭证区和三种项目成员角色的备份操作 UI。
- `pnpm vitest run tests/unit/backup-authorization.test.ts tests/unit/release-pipeline.test.ts`：2 个测试文件、15 个用例全部通过，覆盖历史 backup scope mismatch 和不可降级的 migration 022 release 合同。
- release workflow 的项目成员门禁：15 个测试文件、73 个用例全部通过，包含项目/环境 schema 冲突、backup 列表 scope 与摘要 DTO 回归。
- `pnpm vitest run tests/integration/actions.test.ts`：10/10 通过，覆盖 Hasura Action Bearer Token 与 session variable 一致性。
- `pnpm vitest run tests/unit/project-service.test.ts tests/integration/project-query.test.ts`：18/18 通过，包含 writable CTE 与多语句只读绕过回归。
- 本批次修改的全部 Admin TypeScript/TSX 文件定向 ESLint：0 错误；`pnpm build`：6/6 workspace 包成功，Next.js 产出项目成员路由。
- 根级 `pnpm lint` 仍有 12 个既有 Admin 错误，均位于本批次未修改文件，另有 8 个 warning；本批次文件不在失败清单中。
- 根级 `pnpm test` 的一次环境集成运行结果为 171 个文件通过、11 个失败、2 个跳过；31 个失败集中在 Redis 不可达、Hasura secret/Realtime URL 不匹配、并行数据库死锁/残留测试状态及既有 E2E fixture，不含项目成员授权定向门禁。不能据此宣称全仓 integration/e2e 门禁已闭环。

### 16.4 Review 结论与发布边界

直接 review 期间已修复：inactive 成员无法清理、backup 跨 workspace schema 与 capability 过滤、非 super_admin 平台导航、环境 capability 异步到达后不加载、project/schema 403 后 access 未失效，以及 viewer SQL 只读绕过。随后独立 reviewer 发现并修复两项重要 UI 问题：workspace 备份页错误调用 super_admin 全局列表且未按 capability 隐藏操作，以及 API 页面把文档入口和数据库凭证错误绑定到 `api_keys:manage`。高风险复审继续发现并修复四项重要问题：历史 backup scope 不一致可能跨项目下载/恢复、手动 release 可降级 migration 022 合同、环境 schema 重名会让授权解析随机绑定项目，以及 backup 列表会暴露 scope 不一致记录的 schema/表/存储元数据。对应修复包括详情与列表双层 backup scope 校验、列表摘要 DTO、不可覆盖的 release migration 合同、schema 多归属 fail-closed 解析，以及项目与环境创建共用的 schema 冲突门禁；普通 PostgreSQL 与 PostGIS 的历史 schema 歧义审计均为零行。第四轮独立 `critical_reviewer` 复审结论为无 Critical、无 Important findings；仅保留 tenant-level backup owner UI 在空项目/访问请求失败时可能错误隐藏操作，以及两个兼容 backup 页面重复实现两项 Minor，均不影响服务端授权安全。

生产环境尚未应用 migration `022`，也未构建或发布对应 stable 镜像/manifest，更未执行预发布同构演练或生产 OTA。生产发布前必须按 release guide 备份、应用 022、校验成员表与 digest，并重新执行目标环境健康和回滚门禁。
