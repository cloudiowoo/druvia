# Data Access v2 授权投影设计与实施方案

状态：Druvia 平台实现完成，等待 PITCHETCH 合同对齐与联合验收
Owner：Druvia Data Access
日期：2026-09-15

## 1. 背景

现有 Data Access 只支持 `none / all / owner`。`owner` 只能判断来源表中的 owner column
是否等于服务端派生的 `X-Hasura-User-Id`，无法表达“记录属于当前用户，并且应用当前仍允许该
用户读取”的动态授权条件。

PITCHETCH 将通过应用 migration `0014` 提供当前项目 schema 内的只读
`session_access_projection` view。该 view 使用 PostgreSQL 数据库时间、套餐、槽位、降级期限和
replacement 状态，按 `(session_id, user_id)` 最多输出一条当前可读记录。九张公开表需要使用
单跳 object relationship 将 owner 条件与投影中的 actor/allow 条件以 `AND` 组合。

投影的业务计算属于应用；Druvia 只提供可复用、受约束、可恢复的 Hasura authorization
projection 管理能力，不开放任意 Hasura permission JSON、SQL、Session Header 或布尔表达式。

## 2. 目标

1. 定义向后兼容的 Data Access policy v1/v2 合同；旧请求缺少版本时只按 v1 解释，任何 v2
   字段出现在 v1 请求中都必须拒绝，所有层级的未知字段必须拒绝。
2. v2 只允许 authenticated select 在 `owner` 基础上附加单跳
   `authorization_projection`；insert/update/delete 和 anonymous 行为保持 v1。
3. actor 固定为 `X-Hasura-User-Id`，filter 固定为 owner、projection actor 和布尔 allow 三项
   `AND`；禁止 `OR`、任意操作符和值。
4. 通过项目级批量 preview/apply/recover 一次管理目标 view、多个 object relationship 和多个
   select permission，不产生部分 owner-only 可访问状态。
5. 每表独立保存 relationship mapping、目标 view、actor/allow column、view/relationship
   dependency digest 和完整 permission snapshot。
6. view、关系、字段、类型、owner、安全属性或 metadata 漂移时失败关闭，不能退回 owner-only。
7. 投影视图对项目 authenticated/anonymous scoped role 保持零 CRUD permission。
8. 在 Hasura CE v2.48.0 验证直接查询、relationship traversal、mutation `affected_rows`、
   `returning`/`insert_one`、metadata reload、失败恢复和重复应用。
9. 保持 v1 baseline、现有 custom/legacy/external role 和显式 column grants 兼容。
10. 支持空库确定性重建；本轮不包含 PITCHETCH 生产备份恢复、历史 backfill、生产降级或客户端
    并行兼容窗口。

## 3. 非目标

- 不把 PITCHETCH 套餐、槽位、deadline、replacement 或 basic/complete 语义写入 Druvia。
- 不由 Druvia 执行或接管工作区外 PITCHETCH migration；其机器合同只用于契约核对和联合验收。
- 不支持多跳关系、array relationship、跨 schema/source、任意 predicate AST 或 anonymous 投影。
- 不修改 SDK、Project Session、GraphQL actor 或 Realtime token 契约。
- 不在本轮将 PITCHETCH `0014` 应用到活动 PostGIS。
- 不自动接管无法严格识别的 custom permission。

## 4. 策略合同

### 4.1 v1/v2

API 响应始终返回 `policyVersion`。兼容期内，旧写请求缺少 `policyVersion` 时按 v1 处理，但仅允许
既有 v1 字段；请求携带 `selectConstraint` 时必须显式声明 `policyVersion: 2`。v1 读取响应
不返回该字段，保证原样回写可用；v2 则必须提供非空约束。

```ts
type DataAccessPolicyVersion = 1 | 2

interface AuthorizationProjectionSelectConstraint {
  type: 'authorization_projection'
  relationshipPath: [string]
  actorColumn: string
  allowColumn: string
}

interface TableDataAccessInput {
  policyVersion: DataAccessPolicyVersion
  authenticated: {
    select: 'none' | 'all' | 'owner'
    insert: 'none' | 'all' | 'owner'
    update: 'none' | 'all' | 'owner'
    delete: 'none' | 'all' | 'owner'
    ownerColumn: string | null
    selectConstraint?: AuthorizationProjectionSelectConstraint | null
  }
  anonymous: { select: boolean }
}
```

约束不为空时必须同时满足：

- `policyVersion === 2`
- authenticated select 为 `owner`
- owner column 是来源表可读列
- relationship path 只有一个合法 Hasura 标识符
- 目标关系由同一次受管 projection operation 建立或已由相同 dependency baseline 证明
- actor column 是目标 view 的 UUID 列
- allow column 是目标 view 的 boolean 列；NULL 按不允许读取处理

物化 filter 固定为：

```json
{
  "_and": [
    { "<ownerColumn>": { "_eq": "X-Hasura-User-Id" } },
    {
      "<relationship>": {
        "<actorColumn>": { "_eq": "X-Hasura-User-Id" },
        "<allowColumn>": { "_eq": true }
      }
    }
  ]
}
```

规范化时保留数组顺序，relationship mapping 按 source column 排序。v2 baseline 的反向识别只
接受这一精确形态。存在 baseline 时，状态判断优先比较规范化原始 scoped permission 与 baseline
快照；没有 provenance 时才允许严格 adoption 解析。

### 4.2 项目级投影合同

```ts
interface AuthorizationProjectionContract {
  contractVersion: 1
  policyVersion: 2
  view: {
    name: string
    projectionMode: 'sparse_allow_list'
    key: string[]
    columns: Record<string, 'uuid' | 'boolean' | 'text'>
    clientPermissions: { select: false; insert: false; update: false; delete: false }
  }
  relationships: Array<{
    table: string
    name: string
    type: 'object'
    mapping: Record<string, string>
    ownerColumn: string
    actorColumn: string
    allowColumn: string
  }>
}
```

合同 schema 不接受客户端指定，始终由 `projectId` 的当前 schema 派生。关系名称、表名、列名都
使用 PostgreSQL/Hasura 安全标识符校验。目标必须是当前项目 schema 中已存在的普通 view，不接受
materialized view、table、function 或跨 schema relation。

## 5. 依赖检查

preview/apply 均在项目 Data Access 排他锁内读取 PostgreSQL catalog 和 Hasura v2 metadata：

1. view `relkind = 'v'`，owner 等于项目 `db_user`。
2. `security_barrier=true`、`security_invoker=false`，PUBLIC 无表级 privilege；完整排序后的
   `reloptions` 进入依赖摘要。通过 `pg_rewrite`/`pg_depend` 递归枚举的全部非系统 relation 依赖
   必须留在 operation 固定的项目 schema，并以 schema/relation/kind 排序后进入摘要；同 schema
   helper view 也不能间接引用其他环境 schema。闭包同时沿 `pg_inherits` 递归全部 inheritance/partition
   descendant，跨 schema child 失败关闭。递归 view 闭包只能依赖 PostgreSQL 系统函数；直接函数以及
   custom operator 对应的项目或 extension implementation function 当前统一失败关闭。
3. view 字段与合同完全匹配；actor 为 UUID，allow 为 boolean；NULL 与缺少投影记录均按拒绝读取处理。
4. projection key 包含 actor column，当前结果不存在重复 key。
5. 每张来源表存在且已跟踪，mapping 两侧字段存在且类型一致。
6. relationship 必须唯一存在，只接受名称、目标、mapping 和完整 `using` 结构完全一致的 object
   relationship；同名 array relationship、缺失关系或额外 `using` 字段均失败关闭。
7. view 已跟踪时，两个项目 scoped role 都不得存在任何 CRUD permission；其他 role 规则不由本
   功能接管，但会使 projection activation 失败，避免把内部 view 暴露为受管安全依赖。
8. `pg_get_viewdef(..., true)` 仅裁剪首尾空白后与 owner、reloptions、列类型/nullability、表级/列级 PUBLIC ACL、
   relationship metadata 和 mapping 共同形成 dependency snapshot/digest；不得折叠定义内部空白，
   以免把 SQL 字面量内容不同的定义误判为相同。

任一检查失败返回脱敏错误并且不写 metadata。已激活 baseline 后依赖漂移进入
`dependency_invalid`，普通保存/reconcile 不得移除约束或退回 owner-only。

## 6. 持久状态与迁移

新增 migration `027_data_access_authorization_projections`：

- `druvia_data_access_managed_policies.policy_version` 允许 `1 / 2`。
- baseline 增加 nullable `dependency_snapshot` 与 `dependency_digest`；v1 必须为空，v2 必须存在。
- 新增项目级 `druvia_data_access_projection_operations`，保存不可变 contract、每表 baseline revision、
  source/target scoped metadata、dependency snapshot、resource version、digest、writer lease、状态和
  脱敏错误。
- operation 状态为 `preview_ready / applying / recovering / completed / failed /
  recovery_required / superseded`。
- 活动 projection operation 与 migration `019`、单表 policy operation、表删除及其他 schema/
  metadata 写入互斥。
- migration down 在任何 v2 baseline 或 projection operation 存在时以 `55006` 失败关闭。

每表 baseline 仍是最终逻辑策略事实源；项目 operation 只负责跨表/relationship 的一致提交和恢复。

## 7. Preview、Apply 与 Recover

### 7.1 Preview

1. 严格解析合同并取得项目锁。
2. supersede 旧 `preview_ready`。
3. 导出带 `resource_version` 的 Hasura metadata。
4. 检查 view、九表、现有 baseline 和全部依赖。
5. 每张表必须已有 managed v1/v2 baseline；custom、adoption、refresh 或 recovery 状态阻断。
6. 合同必须覆盖项目 schema 内全部现有 v2 baseline；允许加入新的 v1 表，但不能遗漏旧 v2 表。
7. 目标只改变 authenticated select filter 和 policy version；保留 insert/update/delete、anonymous、
   column grants 和所有非 scoped metadata。
8. 构造完整目标 metadata 与每表 v2 baseline，持久化 source/target snapshot 和 digest。

### 7.2 Apply

1. 校验 operation、项目 alias、source/target digest 和每表 baseline revision。
2. 重新导出 metadata，要求完整 `resource_version` 与预检一致，并复验数据库 dependency 与
   source digest；任意项目在期间完成的 metadata 更新都会使 apply 失败并要求重新预检。
3. CAS 进入 `applying` 并写 writer lease。
4. 使用一次携带 `resource_version` 的 `replace_metadata` 提交 view track、九条 relationship 和九张
   表 permission；`allow_inconsistent_metadata=false`，禁止退回普通 `bulk`。
5. 重新导出并验证完整 target metadata 和 dependency。
6. 在一个 PostgreSQL 事务中更新九条 baseline 并完成 operation。

### 7.3 失败与恢复

- Hasura 明确 4xx 拒绝且 metadata 未变：operation `failed`。
- timeout、transport、5xx 或数据库 commit 结果不确定：进入 `recovery_required`，保留最后 writer
  deadline，并在 deadline 加 drain window 前拒绝恢复。
- recover 重新导出并比较 source/target：完整 target 时补交 baseline；仅从未成功写入 target 的 operation 在完整 source 时标记未应用。已有 `target_resource_version` 的完成批次即使 metadata 恰好回到旧 source，也按漂移整批失败关闭，不能恢复 owner-only。
- 当前状态既非 source 也非 target时，使用同一个 `replace_metadata` 将目标表 authenticated select
  全部移除，同时保留写权限、anonymous 和非 scoped metadata；验证后记录 `failed_closed` 错误。
- fail-closed 状态只能通过新的、完整 preview/apply 恢复，不能逐表打开 owner-only；活动状态查询优先 writer、最新成功和失败关闭证据，后续 preview_ready/superseded/failed preview 不得隐藏该 provenance，只有更新且 completed 的批次可以替代。恢复入口只接受项目最新成功 apply 的批次；成功 apply 标记在后续 fail-closed 后仍参与新旧排序，历史批次无法重放旧合同。completed recovery 在同一数据库事务中先 supersede 其他未应用 preview 再 claim，claim 失败时 rollback，避免 active-project 唯一索引阻断安全关闭。
- v2 表出现列能力 drift 时，项目 preview 必须先拒绝。单表 reconcile 仅保持原 policy version、select constraint 和 dependency snapshot/digest，按当前能力收缩已失效 grants；服务端拒绝扩大 grants 的请求，新增列保持零授权，不能借 reconcile 修改投影合同。preview、apply 接纳、metadata 写入前和 baseline 提交前分别重算依赖；任何一次不匹配均返回 `DATA_ACCESS_PROJECTION_DEPENDENCY_INVALID`。
- 已完成批次出现 dependency drift 时，Admin 提供显式“安全关闭”入口；同一项目锁内复验后，依赖
  仍不一致即整批移除 authenticated select。

## 8. Admin

项目 Data Access Overview 增加“授权投影”操作入口：

- 通过文件选择或文本输入导入 JSON 合同，但只显示业务化摘要，不提供原始 Hasura 编辑器。
- preview 展示 view、目标表、owner/mapping、allow column、v1->v2 和依赖检查结果。
- 明确提示该操作只收紧读取，不改变写权限和字段 grants。
- apply 使用确认模态框和项目 alias；进度展示 preview/apply/verify/recover。
- `dependency_invalid` 显示“授权依赖异常”，提供需要项目别名确认的“安全关闭”，不提供 owner-only
  降级按钮。
- 合同和凭证只保存在组件内存，不持久化到浏览器存储。

## 9. 测试与验收

### 9.1 单元测试

- v1 缺省版本兼容；v1/v2 所有层级未知字段拒绝。
- v1 携带 constraint、v2 非 owner select、多跳、非法标识符、错误 actor/allow 类型拒绝。
- v2 物化产生精确 `_and`，inspection 可识别规范形态，任意变体保持 custom。
- dependency snapshot/digest 稳定，view/owner/options/ACL/columns/mapping 变化可检测。
- preview 保留所有写策略、anonymous 和 column grants。
- batch source/target digest、revision CAS、幂等 apply、timeout recover、仅最新 completed 可恢复、fail-closed。
- v2 激活后增删列的受限 reconcile、dependency provenance 保持及新增列零授权。
- v1 baseline 和现有单表 reconcile 行为不变。

### 9.2 Hasura v2.48 集成

使用中性 schema，不复制 PITCHETCH 商业 SQL：

- 建立 source tables、`authorization_projection` security-barrier view 和九条合同。
- view 对 scoped roles 无直接 CRUD，GraphQL schema 不暴露 view/relationship 字段。
- owner + actor + allow 同时成立才可直接或经 relationship 读取。
- missing row、allow=false、cross-user 均无结果。
- insert 只请求 `affected_rows` 成功；Hasura 2.48 的 `returning` 和 `insert_one` 会回显由 insert
  permission 接受的新行，但该行随后仍可能不满足 select 投影。该回显不是读取授权证明，目标应用
  的不可读候选写入必须只请求 `affected_rows`。
- metadata reload 后结果一致；删除/替换 view、列或关系触发 dependency invalid。
- 注入 metadata timeout/部分状态并验证 recover 或统一关闭 select。

### 9.3 联合验收

Druvia 隔离验收通过后才允许 PITCHETCH 在可清理本地 PostGIS 应用 `0014`。随后导入其机器合同，
使用两个 Project Session 验证九表、deadline、staging candidate、cross-user、mutation 和从
`0001` 重建。联合验收不属于本轮 Druvia 代码完成的前置条件，但属于 DATAACCESS0 最终关闭条件。

## 10. 实施任务

- [x] Task 1：以失败测试冻结 v1/v2 类型、严格输入和 permission materialization/inspection。
- [x] Task 2：实现 catalog/metadata dependency inspector 与稳定 digest。
- [x] Task 3：新增 migration 027、repository 和项目级 operation 状态机。
- [x] Task 4：实现 projection preview/apply/recover 路由、授权和失败关闭。
- [x] Task 5：更新 overview、单表状态和 reconcile 对 v2/dependency drift 的处理。
- [x] Task 6：实现 Admin 合同导入、preview/apply/recover 和状态展示。
- [x] Task 7：增加 Hasura v2.48/PostgreSQL 集成测试及故障注入。
- [x] Task 8：同步 AGENTS、design decisions、progress、release migration ceiling 和 playbook。
- [x] Task 9：运行 API/Admin build、单元/集成回归、migration up/down 门禁与 diff 检查。

## 11. 实施结果与联合门禁

### 11.1 Druvia 已完成

- API 严格解析 policy v1/v2 与项目投影合同；单表 update/adoption/reconcile 不能创建或覆盖 v2。
- contract mapping 必须完整且仅一次覆盖 view key，并要求来源 owner column 映射到目标 actor column。
- migration `027`、baseline dependency snapshot、项目 operation、writer lease、完整 metadata
  resource-version CAS、明确拒绝与未知结果 drain、最新成功 apply 批次失败关闭和失败关闭后的新批量
  预检入口已实现；成功 apply 标记在 fail-closed 后仍阻断旧批次恢复，完成批次漂移回旧 source 也会
  失败关闭，且后续无效 preview 不会遮蔽最近成功/失败关闭状态；未应用 preview 会在 completed
  recovery 的同一事务中 supersede。投影视图递归 relation 依赖闭包已限制在固定项目 schema，
  helper view/materialized view 的 definition、owner、完整 options、表级/列级 PUBLIC ACL 和输出列也进入 digest；
  inheritance/partition descendant 同样进入闭包并受固定 schema 约束，直接函数和 custom operator
  implementation 中的非系统函数依赖被拒绝；definition 摘要保留 SQL 字面量内部空白，受管 relationship
  必须唯一且完整 `using` 一致。其他环境 schema 或 apply 后改写的 helper 不能参与授权计算。v2 列能力
  drift 的受限单表
  reconcile 保持投影 policy/constraint/dependency 不变，只收缩 grants 并拒绝授权新增列，同时在
  preview、apply 接纳、metadata 写入前和 baseline 提交前复验依赖；项目投影 preview、apply
  写入前后及 target recovery 持久化前均复验列能力，避免 PostgreSQL DDL 不推进 Hasura resource version
  时持久化过期 capabilities。
- Admin 数据访问页提供 JSON 导入、业务摘要、项目别名确认、应用、状态和显式恢复确认；浏览器不
  持久化合同。
- release workflow 已纳入全部 projection 单元/真实集成门禁，双 Registry manifest migration ceiling
  均提升到 `27`、`minUpdaterVersion` 提升到 `0.2.0`，完整 manifest 生成器也会拒绝更低或无效版本；API migration floor/ceiling 和兼容 pre-027
  列结构的 updater v2 文件回滚门禁已实现；migration `027` 持久 gate 与跨回滚阶段的 PostgreSQL
  session-level exclusive advisory lock 会排空并持续冻结 Data Access mutation，旧 API 在健康验证前
  无法写入；回滚阶段和健康轮询持续校验具名 holder，holder 丢失即中止当前步骤并停止旧服务。
  关闭 gate 或确认 holder 释放失败会尝试重新启用持久 gate，停止旧服务并保留 operation；updater 重启会先停止中断部署，
  再将持久状态转换为只能重试回滚的失败状态。停止服务和 PostgreSQL 探针直接使用 release Compose 中固定的容器名，
  不解析可能损坏的新 Compose。migration down 在等待表锁前检查 holder/gate 并限制锁等待。
  对 pre-027 无 gate 表的旧数据库，holder 持锁至 updater 显式终止；ready 探针不能因表缺失跳过锁检查。
  在 teardown 的数据库步骤内再次检查具名 holder，预检拒绝和 teardown 失败都保留原始备份身份并阻断
  后续更新。apply 持久阶段区分备份准备、备份完成、文件可能已切换；备份文件、目录以及状态文件
  在 `backup_ready` 前同步到磁盘；staged manifest/Compose/env 与各自目录在发布 `ready_to_apply` 前同步，
  apply 前复验 manifest 版本/迁移、Compose SHA256 及 env 中的镜像 digest；切换后的发布文件及其目录在迁移/服务启动前同步，回滚旧文件也在
  重新启动服务前完成同步。状态文件与其目录同步到磁盘
  后才确认阶段转换，重启时早期阶段也要与活动发布文件/备份比对，无法证明文件未切换则先停服务并进入
  回滚恢复。管理端对成功发布后的文件回滚要求单独确认，并明确数据库不会自动恢复。
  手工回滚在开始状态转换前选定并持久化真实备份 ID，即使成功更新后操作 ID 已清空，重启恢复仍能定位原备份；
  恢复前核对旧 Compose 与 release env 文件均存在。成功 apply 另存目标版本绑定的备份 ID，
  后续检查更新的操作 ID 不再能冒充备份；缺少该证据的旧状态拒绝按目录 mtime 猜测备份。
  并发操作在首次异步读写前占用准入锁，回滚备份身份在同一准入锁内按当前版本选定并持久化，
  回滚成功后按备份 env 恢复当前版本。
  updater 启动或轮询发现持久 `finalizing` 时检查具名 finalizer 容器；容器仍运行则继续等待，确认已
  停止/不存在才收敛为核心更新成功且 updater 自更新待人工处理，Docker 不可用时保持原阶段待重试。
  管理端仅在当前版本匹配最近成功 apply 备份、或失败 apply 带原备份 ID 时启用回滚；普通检查失败
  不提供回滚操作。
  独立 `Updater Bootstrap Release` workflow 只构建 updater，且在登录 Registry 前运行真实 PostgreSQL 17
  rollback-gate 集成门禁；干净 checkout 先构建 shared package 再运行 updater 测试和构建；
  在 Registry 登录前下载并验证指定旧稳定 release 的双 manifest/Compose/digest，tag 只做漂移核验；
  bootstrap `make_latest=false`，目标客户端必须临时使用显式版本 manifest URL。首次发布前仍必须实际执行。
- 本地活动 PostGIS 曾执行 `027 down -> up` 验证此前 migration 文件；本轮调整的 down fail-fast
  路径另以隔离 schema 的 PostgreSQL 集成测试验证，尚未在活动库重新执行 down/up。测试临时项目、schema 和
  projection operation 清理后数量为零。备用普通 PostgreSQL 未迁移，切换前必须单独执行 `up`。

### 11.2 验证证据

- 单元门禁覆盖严格合同、完整 key mapping、策略物化/反向识别、dependency digest、operation
  repository、writer lease、明确 Hasura 拒绝、未知结果恢复、失败关闭后重试、overview 和 Admin
  恢复确认；本轮隔离的 unit/SDK/API 全量为 182 个文件、1493 个用例通过。
- 真实 PostgreSQL 17 + Hasura CE `v2.48.0` 中性 schema 门禁通过：owner A/B、allow=false、缺少
  投影、跨用户、隐藏 view/relationship、重复 apply、metadata reload、`affected_rows`、mutation
  response、v2 激活后新增/删除列 reconcile、dependency digest 保持、view definition/`security_invoker`
  drift、已完成批次回到旧 source 的安全关闭、关闭后读取拒绝、存在 preview_ready 时的事务化安全关闭、
  superseded/failed preview 不遮蔽最近成功批次、跨环境 schema relation dependency 拒绝，以及 helper
  view definition 单独漂移均已验证。
- Hasura 导出会省略 `allow_aggregations:false`；source/target metadata digest 已将显式 false 与省略
  表示规范化为同一语义，同时保留 true 和其他字段差异。
- 未知写结果只有在 metadata 内容与来源一致且 resource version 也未变化时才能视作未应用；
  即使内容后来回到来源快照，只要版本已推进，恢复必须关闭受影响的 authenticated select。
- 已完成批次即使 metadata 摘要仍等于记录的 target，恢复前也要将每张表当前 scoped permission
  与最新 baseline 列 grants 物化结果对比；旧目标扩大了后续 reconcile 收缩的授权时统一关闭 select。
- Hasura 2.48 实测 `returning`/`insert_one` 可回显本次 insert 接受的新行，但后续 query 仍被投影
  拒绝。Druvia 本轮不增加 GraphQL 文本代理特例；PITCHETCH bulk mutation 必须只请求
  `affected_rows`。
- projection 与 updater rollback 两条真实集成门禁均通过：projection 覆盖 custom operator、跨 schema
  partition descendant 和 PUBLIC column ACL；rollback 覆盖持久 gate、并发共享锁排空，以及安全检查后
  session holder 继续阻断 pre-027 mutation，以及无 gate 表时显式释放、holder backend 被杀后的探测、
  teardown 前 holder 消失失败关闭、gate 激活期间清理旧 holder 和 migration down 有界失败。teardown 失败、后台 holder 丢失、
  健康检查挂起中止、预检拒绝、备份准备中断及手工回滚重启保留原备份 ID 已有单元回归。
  6 个 workspace package 本轮构建通过；本次
  Admin 文件定向 ESLint、workflow YAML、release 脚本语法和 `git diff --check` 通过。仓库全量
  lint 仍有 12 个既有 Admin error 和 6 个 warning，均位于本次未修改文件，未纳入本切片扩展修复。

### 11.3 PITCHETCH 尚需对齐

当前 `backend/hasura/0004_commercial_access_contract.json` 不能直接导入，必须由 PITCHETCH 仓库
更新后再进入联合验收：

- 增加顶层 `policyVersion: 2`。
- 移除顶层 `schema`；Druvia 始终从 project ID 派生 schema。
- 移除 view 内说明性 `denialSemantics`，或将其留在应用文档而非机器合同。
- 九条 relationship 分别增加 `ownerColumn: "user_id"`。

PITCHETCH migration `0014` 当前已正确将 view 设为 security barrier、owner 转移给
`dru_default_pitchetch_user` 并撤销 PUBLIC 权限。本轮未将 `0014` 应用到活动数据库；合同对齐后再由
PITCHETCH 执行 migration，并通过 Druvia Admin 导入合同完成九表、双 Project Session、Realtime
及空库重建联合验收。

## 12. 发布边界

本功能新增平台 migration，后续镜像发布必须将 release manifest migration ceiling 提升到 `27`，
并要求数据库备份。该 API 要求数据库 migration floor/ceiling 均为 `27`。rollback gate 由 updater
`0.2.0` 提供且版本来自镜像内编译常量。首次 migration `027` release 前必须先用不含该 migration、
保留指定旧稳定 release API/Admin/Worker digest 与 Compose 的 updater-only bootstrap release 更新
updater；bootstrap 会占用一个稳定产品版本但不成为 GitHub latest，客户端必须临时使用显式版本
manifest URL，完整 release 必须使用更高版本并恢复 latest、要求 `minUpdaterVersion >= 0.2.0`。updater
在 migration `027+` 文件回滚前先停止 API/Admin/Worker、启用 gate，再在 gate 激活期间清理旧 holder，以全局排他锁排空
mutation，并用兼容 migration 023-026 列结构的查询检查 v2 baseline 和全部 projection operation，不依赖
update state；检查通过后 session-level exclusive holder 持续覆盖旧文件恢复、pre-027 API 启动和健康验证。
存在 v2 状态时拒绝 file-only rollback；恢复开始后的失败会停止旧服务并保留 gate/holder，必须先恢复
匹配旧版本的数据库备份或修复后重试同一 rollback。生产启用前仍需完成独立的
PITCHETCH 联合验收与正式发布门禁。本轮不发布镜像、不执行 OTA，也不修改活动 PITCHETCH schema。
