# Data Access 受管策略演进与刷新设计及实施方案

状态：Druvia 平台核心实现与当前真实集成路径已完成；关键故障注入、PITCHETCH 应用侧验收和生产发布待继续
Owner：Druvia Data Access
日期：2026-09-06

## 1. 背景

PITCHETCH 在本地应用 migration `0003_analysis_and_heatmap` 后，为
`dru_default_pitchetch.football_session` 增加了两个普通 PostgreSQL 列：

- `target_algorithm_version`
- `current_analysis_run_id`

该表原有项目 scoped role permission 由 Druvia Data Access 生成，认证用户保持
owner-select 和 owner-insert，update/delete 关闭。新列尚未进入任何 Hasura permission，
因此当前运行态没有发生权限扩大。

Druvia 当前根据“permission 列集合是否与当前数据库全部可读/可写列精确相等”反向判断
规则是否受管。新增列使原有显式列数组不再精确匹配，状态被判断为 `custom`；普通更新 API
为避免覆盖自定义规则而返回 HTTP 409。PITCHETCH 因此无法继续同步 M4 Data Access，四张
派生表的 owner-select、双 Project Session 和 RPC 联调仍处于阻塞状态。

现有系统只保存 `none / all / owner` 逻辑模式，不持续保存每张表最后一次由 Druvia 下发的
实际 permission、操作级列集合或来源 digest。migration `019` 只负责已有项目从
compatibility 到 explicit 的一次性迁移；PITCHETCH 已是 explicit，且没有对应的 019
迁移记录，不能将该表的历史权限自动证明为 Druvia 受管规则。

本功能补充长期的受管策略 provenance、Schema 漂移识别、adoption、reconcile、失败恢复和
幂等验证。它不是放宽 custom 覆盖保护，也不通过直接修改 Hasura metadata 绕过 Druvia。

## 2. 目标与非目标

### 2.1 目标

1. 持久化每张表最后一次经过 Druvia 验证的逻辑策略、实际列授权和 scoped permission。
2. 将“受管 metadata 未变但数据库列能力已变化”识别为 `refresh_required`，不误报为
   `custom`。
3. 为没有 provenance、使用显式列数组的既有 scoped permission 提供只记录不改权限的
   adoption；Hasura `columns: '*'` 不得被接管。
4. 提供带 source/target digest 的 reconcile preview/apply/recover。
5. 新增列默认不进入 select、insert 或 update；管理员必须逐项显式授权。
6. PostgreSQL 列删除或 generated/identity 能力收紧时，从目标写权限中移除无效列并明确展示。
7. 普通策略保存、adoption 和 reconcile 共用持久操作状态机，防止 Hasura 与策略基线漂移。
8. 仅管理当前项目 authenticated/anonymous scoped roles，保留真实 custom、legacy 和其他
   role 规则。
9. 在 Admin 中以业务化状态展示结构变化、接管、刷新、失败恢复和列级差异。
10. 使用真实 PostgreSQL 17、Hasura v2.48 和 Project Session 验证权限没有静默扩大。

### 2.2 非目标

- 不修改 PITCHETCH 业务 migration、业务表数据或分析算法。
- 不改变 Project User、API Key、Platform User、Trusted Backend Key 或 Project Session。
- 不把任意 Hasura permission 编辑器开放到 Admin。
- 不自动接管列集合为当前能力子集的规则。
- 不自动授予新增可读列或可写列。
- 不把 migration `019` 改造成长期策略历史表。
- 不修改 SDK、GraphQL 代理、Realtime token 或 RPC 契约。
- 不在 OTA 中自动应用项目业务侧 Data Access 变更。

## 3. 方案比较与决策

### 3.1 持久化受管基线与独立 reconcile 状态机

为表级策略持久化精确 permission 与能力快照，Schema 变化后以基线为来源判断漂移，并用
独立操作状态机执行 adoption、策略保存、reconcile 和恢复。

优点是来源明确、默认最小权限、可恢复且可持续支持应用 Schema 演进；代价是需要新增平台
migration、API 状态流和 Admin 界面。

结论：采用。

### 3.2 复用 migration 019

migration `019` 的状态、确认和 rollback 都围绕 compatibility 到 explicit 的一次性切换，
并且 applied snapshot 按现有约束不可变。将长期表策略写入其中会混淆迁移与持续治理语义。

结论：拒绝。

### 3.3 基于列子集启发式放宽 inspection

同一 owner filter 加较小列集合既可能是旧版平台生成规则，也可能是运维人员有意设置的字段级
限制。仅凭当前 metadata 无法区分两者，自动改为 managed 会产生静默扩权风险。

结论：拒绝。

## 4. 核心安全不变量

1. provenance 只能来自 Druvia 成功写入并重新验证的基线，或管理员显式确认的 adoption。
2. 没有基线但存在结构受支持的 scoped permission 时只能进入 `adoption_required`，不能自动
   识别为 managed；结构不受支持时直接进入 `custom`。
3. 当前 scoped permission 与已保存基线不一致时必须进入 `custom`，不能执行 reconcile。
4. 新增列默认不获得读取或写入权限；授权动作必须出现在 preview 和确认请求中。
5. insert/update 的最终列必须分别属于当前 insertable/updateable capability。
6. owner insert 继续排除 owner column，并由 Hasura preset 写入；客户端不能覆盖 owner。
7. 任何 row filter、check、set、aggregate 或额外 permission 字段变化均按 custom 处理。
8. 只增删当前项目两个 scoped role 的 permission，不修改 legacy `user / anonymous`、其他
   项目 role 或外部 role。
9. 受管基线和 adoption 不接受 Hasura `columns: '*'`。digest 规范化只能排序对象键和显式列
   数组，不能把 wildcard 与当前列数组视为相同；显式项目中的 wildcard 继续按 custom 只读
   处理。compatibility 项目的历史 wildcard 继续由 migration `019` 收紧为显式 scoped 数组。
10. 客户端不能上传 source metadata 或恢复快照；恢复只能使用服务端已持久化的不可变快照。
11. 已有基线上的管理写入必须携带客户端读取到的 baseline revision；项目 advisory lock 只负责
    串行执行，不能代替过期页面的乐观并发校验。
12. 本功能的 policy-operation apply、restore 和 fence metadata mutation 必须携带 v2 export
    取得的 `resource_version`；数据库锁失效后，旧 writer 不能绕过 Hasura 侧的版本 fencing。
13. 数据库和 Hasura 不具备分布式事务，本功能只宣称持久状态机、精确验证和可恢复一致性，
    不宣称跨系统绝对原子。

## 5. 数据模型

新增 migration `023_data_access_managed_policies`。

### 5.1 表级受管基线

新增 `druvia_data_access_managed_policies`：

```text
project_id                 VARCHAR(64), FK druvia_projects, PK part
table_name                 VARCHAR(128), PK part
schema_name                VARCHAR(128)
policy_version             INTEGER
policy                     JSONB
column_grants              JSONB
capabilities_snapshot      JSONB
permissions_snapshot       JSONB
metadata_digest            CHAR(64)
revision                   BIGINT
created_by                 VARCHAR(64)
updated_by                 VARCHAR(64)
created_at                 TIMESTAMPTZ
updated_at                 TIMESTAMPTZ
```

字段语义：

- `policy` 保存 authenticated CRUD 的 `none/all/owner`、owner column 和 anonymous select。
- `column_grants` 保存 authenticated select/insert/update 与 anonymous select 的精确授权列；
  mode 为 `none` 时对应数组为空。
- `capabilities_snapshot` 保存当次验证使用的 readable/insertable/updateable columns。
- `permissions_snapshot` 只保存该表当前项目两个 scoped role 的规范化 permission，不保存
  legacy 或外部 role。
- `metadata_digest` 对规范化 scoped permission snapshot 计算 SHA-256。
- `revision` 每次成功策略保存或 reconcile 增加；adoption 创建 revision 1。
- `schema_name` 用于防止项目 schema 身份变化后误用旧基线，不作为独立资源定位来源。

`project_id + table_name` 唯一。删除项目时级联删除；项目 schema 删除、clean restore 或表删除
必须在现有 Data Access mutation lock 下同步清理或使记录进入可审计的失效状态。

### 5.2 持久操作记录

新增 `druvia_data_access_policy_operations`：

```text
operation_id               VARCHAR(64), PK
project_id                 VARCHAR(64), FK druvia_projects
table_name                 VARCHAR(128)
kind                       adoption | policy_update | reconcile
status                     preview_ready | applying | recovering |
                           completed | failed | recovery_required | superseded
phase                      preview | source_check | persist_baseline |
                           apply_permissions | verify_target |
                           restore_source | verify_source | completed
baseline_revision          BIGINT NULL
source_capabilities        JSONB
source_permissions         JSONB
source_digest              CHAR(64)
source_resource_version    BIGINT
target_policy              JSONB
target_column_grants       JSONB
target_capabilities        JSONB
target_permissions         JSONB
target_digest              CHAR(64)
target_resource_version    BIGINT NULL
request_digest             CHAR(64)
writer_epoch               VARCHAR(64) NULL
write_deadline_at          TIMESTAMPTZ NULL
created_by                 VARCHAR(64)
error_code                 VARCHAR(64) NULL
error_message              TEXT NULL
created_at/started_at/completed_at/updated_at TIMESTAMPTZ
```

不可变字段由数据库 trigger 保护。每个项目最多存在一个 `preview_ready / applying /
recovering / recovery_required` 操作，并与 migration `019` 的活动操作 gate 互斥。新 preview
会在同一项目锁内 supersede 旧的 `preview_ready`；其他项目 Schema/metadata 写入也必须先将
仅处于 preview 的操作标记为 superseded，再继续写入，使旧 apply 必然因 digest 或状态变化而
失败。`applying / recovering / recovery_required` 才是不能自动 supersede 的持久写锁。处于
`recovery_required` 时，现有 DDL、raw SQL、Realtime、表删除、clean restore 和其他会改变
相关 metadata/schema 的入口继续被阻断。

`source_digest` 对规范化的 `{projectId, schemaName, tableName, baselineRevision,
sourceCapabilities, sourcePermissions}` 计算 SHA-256；`target_digest` 对规范化的
`{targetPolicy, targetColumnGrants, targetCapabilities, targetPermissions}` 计算 SHA-256。这样
preview 后即使 Hasura permission 未变，只要 Schema capability 或 baseline revision 变化，
apply 也必须失败。基线中的 `metadata_digest` 仍只表示受管 scoped permission 本身。

`source_resource_version` 来自 Hasura Metadata API `version: 2` 的 export response；本功能的
policy-operation metadata 写入都把预期版本放在请求顶层。`writer_epoch` 标识本次实际 writer，
`write_deadline_at` 由固定 30 秒 metadata 请求上限和 5 秒 drain window 计算。原 writer 在
Hasura 返回后必须用 epoch 与 operation status CAS 证明仍拥有操作，才能提交 target baseline。
超时只表示客户端停止等待，不被解释为 Hasura 已取消执行。

migration down 在任一基线或未清理操作记录存在时拒绝执行；生产升级后使用前向修复。

操作表增加稳定命名的 `BEFORE DELETE` guard：状态为 `applying / recovering /
recovery_required` 时，直接删除或项目 FK cascade 均以 SQLSTATE `55006` 拒绝，并由 API 映射为
HTTP 409。项目删除还必须在 untrack Hasura、删除 Schema、Storage 或其他外部副作用之前完成
policy-operation preflight；数据库 trigger 是最后防线，不能弥补已经发生的外部删除。

### 5.3 表删除 outbox

migration `024_table_deletion_outbox` 持久化跨 PostgreSQL 与 Hasura 的删除意图。删除路由在同一
PostgreSQL 事务中删除业务表、`_meta_tables`、精确匹配 `project + schema + table` 的 managed
baseline，并插入包含 operation ID、lock scope、schema/table、attempts 和脱敏错误码的 pending
outbox；事务提交后才 untrack Hasura，成功后清除 outbox。该顺序不宣称跨系统原子，而是保证任一
可观察失败都有持久恢复依据。

pending deletion 阻断同 scope 的 Data Access 和 Schema 管理写入。API 启动时立即恢复，运行期每
30 秒在 exclusive-global/project lock 下重试；已从 Hasura untrack 的表按幂等成功处理。恢复过程
不得记录凭据或原始 Hasura payload，也不得因无关项目的 pending deletion 阻断其他项目。
migration `024` 的 event trigger 在 pending 生命周期内保留 `schema + relation` 名称；任何数据库
连接尝试创建或重命名为该名称都以 SQLSTATE `55006` 失败，从而关闭 relation check 与 Hasura
untrack 之间的 TOCTOU。执行 migration `024` 的数据库角色必须具备创建 event trigger 的权限，
升级时若缺少该权限应在启动新 API 前失败。`024 down` 在 outbox 非空时以 SQLSTATE `55006`
失败关闭；生产使用后采用新编号前向修复。

## 6. 状态识别

`TableDataAccessState.managedState` 扩展为：

| 状态 | 条件 | 可执行动作 |
| --- | --- | --- |
| `managed` | 当前 scoped permission、能力和基线均一致 | 普通策略保存 |
| `refresh_required` | 当前 permission 与基线一致，但数据库列能力变化 | reconcile preview |
| `adoption_required` | 存在结构受支持、全部使用显式列数组的 scoped permission，但没有基线 | adoption preview |
| `custom` | 当前 permission 与基线不一致，结构不受支持，或包含 `columns: '*'` | 只读检查 |
| `recovery_required` | 持久操作无法验证 source/target，或 `applying/recovering` 已超过 writer deadline 与 drain window | recover |

没有基线且没有 scoped permission 的表视为安全的未配置状态，可由普通 PUT 首次配置并建立
基线。legacy 和 external role 继续单独报告，不因 adoption 被删除或改写。

状态响应新增：

```ts
interface TableColumnAccessState {
  baselineRevision: number | null
  capabilities: {
    readable: string[]
    insertable: string[]
    updateable: string[]
  }
  effective: {
    authenticated: {
      select: string[]
      insert: string[]
      update: string[]
    }
    anonymous: { select: string[] }
  }
  drift: {
    addedReadable: string[]
    addedInsertable: string[]
    addedUpdateable: string[]
    removedOrRestricted: string[]
  } | null
}
```

现有 `columns` 字段继续返回 readable columns，保持管理 API 基础兼容。普通状态响应不返回物理
role、原始 permission snapshot 或 digest；preview/apply 管理响应返回完整 digest 作为并发
完整性令牌，但 Admin 不把它渲染给用户。digest 不是凭据，不能代替服务端重新物化与校验。

## 7. 列授权语义

### 7.1 初次配置

没有基线且没有 scoped permission 时，现有 PUT 输入保持兼容：

- active select 默认使用当前 readable columns。
- active insert 默认使用当前 insertable columns，owner 模式排除 owner column。
- active update 默认使用当前 updateable columns，owner 模式排除 owner column。
- anonymous select 开启时默认使用当前 readable columns。

这是管理员对当前完整 Schema 的显式首次配置，不属于 Schema 漂移自动扩权。

### 7.2 已有基线上的普通策略保存

管理输入可增加可选的精确 `columnGrants`。每次 PUT 必须携带调用方生成并在重试中保持不变的
`operationId`；无基线的首次配置可以继续只提交逻辑 policy，一旦存在基线，调用方还必须提交
`expectedBaselineRevision`：

- 操作 mode 未变化且未提交该操作列集合时，保留基线中的实际列授权。
- 操作在 active mode 之间切换且未提交列集合时，例如 `owner -> all` 或 `all -> owner`，使用
  `baseline grants ∩ current capability`，绝不回退为当前全部 capability；切换到 owner 写模式
  时再排除 owner column。
- 操作从 active 改为 `none` 时清空对应列授权。
- 操作从 `none` 改为 active 时，必须由新版 Admin 提交明确列集合；旧调用方缺失该字段时返回
  HTTP 400，不能隐式授予当前全部列。
- owner column 变化时必须重新提交受影响写操作列集合，并再次验证 preset 能力。
- 当前状态为 `refresh_required` 时，普通 PUT 返回 409，不能借无关策略修改绕过 reconcile。
- `expectedBaselineRevision` 与锁内重新读取的 revision 不一致时返回 409；基线更新使用
  `WHERE revision = expectedBaselineRevision` 的条件写入，影响行数不为 1 同样视为 stale。
- 为安全起见，已有基线上的旧客户端若缺少 revision 必须失败关闭；保留路由和原逻辑 policy
  字段兼容，不承诺旧请求主体可以在不参与并发控制的情况下继续写入。
- operation row 持久化规范化 request digest；相同 operation ID 和相同请求重试返回原 completed
  结果，相同 ID 携带不同请求返回 409。
- operation 同时持久化创建时项目 schema；该字段属于不可变 payload。apply/recover 必须验证项目
  当前 schema 与 operation schema 一致，baseline 的读取和更新也必须精确匹配该 schema。
- 服务端处理 PUT 时先按 `(projectId, tableName, operationId)` 查询 operation 并比较 request
  digest；命中 completed 同请求时直接返回原结果，然后才执行 baseline revision 校验。不得让
  首次成功后已经增长的 revision 把合法响应丢失重试误判为 stale。
- 新 operation ID 提交与当前基线完全相同的 policy/grants 时返回 verified no-op，不发送 Hasura
  mutation，也不增加 baseline revision。

### 7.3 Reconcile

preview 以当前基线授权为起点：

- 新增 readable/insertable/updateable columns 默认均不选中。
- 数据库已删除的列从目标 permission 移除。
- 变为 generated/identity always 等不可写状态的列从 insert/update 移除。
- 管理员只能从当前对应 capability 中显式增加列。
- `delete` 没有列授权，不参与列漂移。
- authenticated select 与 anonymous select 独立选择，不能因前者授权而扩大匿名读取。

## 8. 管理 API

所有路由只接受 Platform User，并继续要求 `data_access:manage` capability。

```http
POST /api/v1/projects/:projectId/data-access/tables/:tableName/adoption/preview
POST /api/v1/projects/:projectId/data-access/tables/:tableName/adoption/apply

POST /api/v1/projects/:projectId/data-access/tables/:tableName/reconcile/preview
POST /api/v1/projects/:projectId/data-access/tables/:tableName/reconcile/apply

GET  /api/v1/projects/:projectId/data-access/policy-operation
POST /api/v1/projects/:projectId/data-access/policy-operations/:operationId/recover
```

### 8.1 Adoption

Preview：

1. 读取数据库列能力和当前表全部 Hasura metadata。
2. 只提取当前项目两个 scoped role permission。
3. 拒绝 `columns: '*'`、重复 permission、额外 preset、非标准 filter/check/set、aggregate、
   未知字段和无法解释的 owner column。
4. 保留并报告 legacy/external role，但不将其写入受管基线。
5. 生成建议逻辑 policy、实际 column grants、source digest 和 operation ID。

Apply 必须提交 `operationId`、`sourceDigest` 和项目别名。服务端再次导出 metadata、读取列能力
并确认 digest 未变化；随后在单个数据库事务中写入基线和 completed 状态，不发送 Hasura 写
请求。重复 apply 返回同一完成结果。

### 8.2 Reconcile

Preview 只允许具有可信基线、当前 permission 与基线一致且列能力已变化的表。响应提供每个
actor/operation 的保留、移除和可选新增列，以及默认不扩权的 target。已有基线且能力未变化时，
管理员仍可通过普通 PUT 的显式 `columnGrants` 调整字段授权；该请求同样进入
`policy_update` 状态机，但不能伪装为 reconcile。

Apply 请求必须提交：

- `operationId`
- `sourceDigest`
- `targetDigest`
- `baselineRevision`
- 项目别名
- 各操作最终 column grants

服务端不信任客户端 target permission，而是以 target policy、column grants、当前 capability 和
role resolver 重新物化并验证 target digest。Schema、metadata、baseline revision 或 preview
选择任一变化均返回 409，要求重新 preview。

错误码固定为：

- `DATA_ACCESS_ADOPTION_REQUIRED`
- `DATA_ACCESS_REFRESH_REQUIRED`
- `DATA_ACCESS_CUSTOM_POLICY`
- `DATA_ACCESS_RECONCILE_STALE`
- `DATA_ACCESS_RECONCILE_RECOVERY_REQUIRED`
- `DATA_ACCESS_WILDCARD_POLICY_UNSUPPORTED`
- `DATA_ACCESS_POLICY_STALE`

客户端只接收脱敏消息；错误码用于 Admin 选择接管、刷新、只读或恢复状态，不暴露 Hasura
内部错误。

### 8.3 普通 PUT

现有路由和逻辑 policy 字段兼容保留，但内部改为 `policy_update` 操作。无基线首次配置可以
省略 revision；所有请求必须提交稳定 `operationId`，已有基线还必须提交
`expectedBaselineRevision`。新版 Admin 在发起动作时生成 operation ID，并从最近一次状态响应
回传 revision；网络重试复用同一 ID 和 payload。成功返回前必须完成 Hasura target 验证、基线
更新和操作完成状态；不能先返回成功后异步补 provenance。

### 8.4 操作发现与恢复入口

`GET /data-access/policy-operation` 返回当前项目尚未终结的操作，或最近一次需要用户处理的操作：

```ts
interface DataAccessPolicyOperationState {
  operationId: string
  tableName: string
  kind: 'adoption' | 'policy_update' | 'reconcile'
  status: 'preview_ready' | 'applying' | 'recovering' | 'completed' | 'failed' |
          'recovery_required' | 'superseded'
  phase: string
  sourceDigest: string
  targetDigest: string | null
  writeDeadlineAt: string | null
  startedAt: string | null
  error: { code: string; message: string } | null
}
```

表状态同时返回精简 `activeOperation`，便于刷新页面后恢复进度。digest 只返回给具有
`data_access:manage` 的平台管理调用方，Admin 不展示。recover 可以从 orphaned `applying`、
`recovering` 或 `recovery_required` 幂等进入；若原 writer 仍持有 advisory lock，则新请求返回
409，不得与正在执行的 apply 并发恢复。锁已释放但 `writeDeadlineAt` 尚未到达时返回带安全
retry-after 的 409；恢复只能在 deadline 和 drain window 均结束后开始。状态查询会把已经超过
该窗口的 `applying/recovering` 派生为 `managedState: recovery_required`，Admin 停止进行中轮询并
显示恢复按钮；不要求后台进程先改写 operation status。

## 9. Apply、故障与恢复

### 9.1 Policy update / reconcile apply

固定顺序：

1. 获取 shared-global 后的 project advisory lock，并将锁持有的 `PoolClient` 传给 operation/
   baseline repository；状态转换不得退回 pool 另取连接后伪装成同一数据库事务。
2. 检查 migration `019` 和 policy operation 均不存在活动或 recovery gate。
3. 通过 Hasura Metadata API `version: 2` 重新导出 metadata/resource version，读取当前
   capability，并验证 source digest、baseline revision。
4. 将不可变 source/target snapshot 和操作状态持久化为 `applying`。
5. 在发送任何 drop/create command 前再次执行 v2 export，校验 source digest 和
   `resource_version`；发生漂移时不得发送写请求，返回 stale/custom。
6. 生成新 writer epoch 和有界 `write_deadline_at`，通过期望 status/phase 的单条条件更新将
   epoch、deadline、第二次 export 的 resource version 和 `apply_permissions` phase 原子持久化；
   该数据库事务确认提交前不得发送 Hasura HTTP 请求。
7. 常规变更优先执行 Hasura `bulk_atomic`，请求顶层携带已持久化的 source resource version。仅对已知
   unsupported 错误回退到 `bulk`，fallback 使用相同 source resource version，版本不匹配必须
   失败，不能重新基于未知 metadata 执行。若列已删除或转为不可写导致 source permission 本身
   inconsistent，则基于同一次完整 export 快照，仅替换目标表当前项目 scoped permission 数组，
   通过 `replace_metadata` 和相同 resource version 提交；不得删除其他 inconsistent object。
8. 重新导出并精确验证 target scoped permission digest。
9. Hasura 返回后，以 writer epoch 和 operation status CAS 确认当前进程仍拥有操作；CAS 失败
   时不得提交 target baseline，转入 source recovery。
10. 使用同一个锁持有的 `PoolClient`，在单个 PostgreSQL 事务内以 expected revision 条件更新
   受管基线 revision，并将操作标记为 `completed`。

正常 apply 只改变当前表和当前项目 scoped roles 的目标 operation。常规路径使用 drop/create；只有
能力收缩已经使 Hasura 拒绝普通 permission command 时才使用上述受控全快照 replace，且变换前后
必须保留其他表、legacy/external role、Remote Schema、Event Trigger 和所有非目标 metadata。

### 9.2 同步失败

Hasura metadata 写入已明确成功，但受管基线 revision 与 completed 状态的最终 PostgreSQL 事务
尚未确认提交时发生错误，按以下顺序自动恢复：

1. 将操作推进到 `recovering / restore_source`。
2. 使用服务端持久化的 source snapshot 恢复当前 scoped permissions。
3. 重新导出并验证 source digest。
4. 验证成功后标记 `failed`，允许重新 preview。
5. 无法验证时标记 `recovery_required`，保留 source snapshot 和恢复目标。

若 Hasura 在执行前返回带结构化 Hasura error code 的确定性 4xx 校验、resource-version 或权限拒绝，视为 metadata 未写入，
操作直接标记 `failed`，不发送多余 source restore。若请求出现 transport/timeout，或 Hasura
5xx，或 v2.48 的非原子 `bulk` fallback 返回错误，则写入结果未知：不得立即恢复或清除 gate，操作转为
`recovery_required`，等待原 writer deadline 与 drain window 后由 recover 使用新的
resource-version fence 恢复 source。不能因为 fallback 返回 HTTP 错误就假定前序 command 未执行。

若最终事务的 `COMMIT` 结果未知，不能直接恢复或标记 failed：

1. 使用新数据库连接重新读取 operation 与 baseline。
2. 两者已按 target revision 原子提交时返回 completed，不回滚已确认的新策略。
3. 两者均未提交时恢复 source。
4. 两者状态不一致或数据库状态无法读取时保留 `applying`；下一次 recover 将其转为
   `recovery_required` 后处理，不能清除 gate。

进程在 Hasura 写入后、数据库完成前终止时，后续管理请求不能忽略仍处于 `applying` 的记录。
recover 必须等待持久化 write deadline 和 drain window 结束，再取得锁并执行 v2 export。随后无论
当前 scoped digest 必须等于 source、target，或等于从持久 source 执行 drop-then-create 到 target 的
某个命令前缀，才允许使用当前 resource version 发送一次可验证的 source restore/fence。第三方
filter、preset、columns 或其他不可解释状态必须保持 `recovery_required`，不能覆盖。允许恢复时需确保
旧 writer 携带的 source resource version 已失效：

- source snapshot 非空时，重新写入精确 source scoped permission；若 source 因已删除列而不再一致，
  使用受控全快照 replace 并显式允许恢复原 source inconsistency，不得影响其他对象。
- source snapshot 为空且没有可执行 permission command 时，使用当前表在 v2 export 中的精确
  customization，执行 resource-version-protected 的同值 `pg_set_table_customization` 作为表级
  fencing；不得使用全量 `replace_metadata`。
- 实现前必须以 Hasura v2.48 集成测试证明同值 table customization 会推进 resource version，
  且不会改变当前表 customization、其他表、Remote Schema、Event Trigger、warnings、
  inconsistent metadata 或现有 GraphQL 可见性；任一条件不成立时保持 `recovery_required`，转入
  运维静默窗口和人工恢复，不能清除 gate。

restore/fence 后再次导出，必须同时验证 source digest 成立且 resource version 已推进，才能将
operation 标记为 failed。迟到的旧 Druvia 请求因携带旧 resource version 被 Hasura 拒绝；原
writer 即使收到迟到成功响应，也会因 epoch/status CAS 失败而进入 source recovery，不能提交
target baseline。只有完整完成 target 验证及基线/状态同事务提交后才保留新策略。

每次 recover/restore 尝试也必须在发送 Hasura 请求前，以 expected status/phase 原子持久化新的
writer epoch、deadline 和当前 resource version；恢复返回后通过同一 epoch/status CAS 验证所有权。
若 operation 在 epoch 持久化前崩溃，尚未发送 Hasura 请求，可由下一次 recover 直接接管；在
epoch 持久化后崩溃，则必须等待对应 deadline/drain 并执行上述 source restore/fence。

### 9.3 Recovery

recover 只接受 operation ID、持久化 source digest 和项目别名确认，不接受客户端 metadata。
恢复成功后状态改为 `failed`；失败继续保持 `recovery_required`。错误消息对客户端脱敏，服务端
记录 request ID、project、schema、table、operation、phase 和 Hasura error code，不记录 token、
header、原始行数据或凭据。

PostgreSQL advisory lock 和 Druvia 使用的 Hasura resource-version CAS 只能约束遵守对应协议的
写入口，不能阻止省略 resource version 的 Hasura Console 或外部 admin-secret 客户端迟到修改
metadata。adoption、policy update、reconcile 和 recover 期间必须使用运维静默窗口，禁止直接
修改相关 scoped permissions。第二次 source export 和 resource version 可以拒绝先完成的并发
变化，但直接客户端仍可能在 Druvia 验证完成后覆盖 target 且无法被本次操作检测；该行为明确
不受支持，不保证自动进入 stale/custom/recovery，也不得被描述为平台原子保证。

## 10. Admin UI

### 10.1 项目概览

表列表增加业务状态：

- 已配置
- 待配置
- 结构已变化
- 需要接管
- 自定义策略
- 需要恢复

`reviewRequired` 对后四种状态为 true。汇总区分待配置数量和需处理数量，避免把已经生效但需要
刷新或接管的表误报为完全未配置。

### 10.2 表详情

- `adoption_required`：显示当前策略摘要和“接管为 Druvia 管理”入口。
- `refresh_required`：按查询、新增、修改和匿名读取分组显示列差异。
- 新增列复选框默认不选中；generated/identity always 写列只读显示为不可授权。
- custom 状态继续只读，不提供 adoption/reconcile 覆盖入口。
- adoption/reconcile 使用确认模态框，确认内容包括项目、表、行范围和字段变化。
- 操作期间显示阶段进度；`recovery_required` 时只显示恢复入口。
- 页面刷新或 API 重启后重新读取 active operation；不得只依赖组件内存保存 operation ID、阶段或
  recover 所需 digest。
- 普通策略编辑器使用后端返回的 effective grants，避免修改 delete 等无关策略时扩大列权限。
- 不展示物理 Hasura role、原始 metadata、digest 或内部恢复快照；digest 仅由 Admin 请求层
  原样回传给 apply/recover。

## 11. PITCHETCH 解阻流程

1. 在不修改 Hasura 的情况下对 `football_session` 创建 adoption preview。
2. 将 preview 与 PITCHETCH 已保存的 pre-M4 Data Access snapshot 人工核对。
3. 确认 adoption，按当前数据库 capability 和现有显式 permission 记录 owner-select/
   owner-insert、关闭 update/delete 的精确基线；因为两个 M4 列在 adoption 前已经存在，完成后
   状态是 managed，不伪造历史 capability drift。
4. 通过普通 managed policy update 显式提交新的 `operationId`、最新
   `expectedBaselineRevision` 和 authenticated select 的 `columnGrants`。
5. 仅将 `target_algorithm_version`、`current_analysis_run_id` 加入 authenticated select；该更新
   仍走 policy-operation apply、target 验证和失败恢复状态机。
6. 两个新列不加入 authenticated insert/update；anonymous 继续关闭。
7. apply 后验证 metadata consistency、目标 digest 和第二次 apply/no-op 幂等性。
8. 继续为 `analysis_run`、`activity_sample`、`session_summary`、`session_heatmap` 配置
   owner-select，普通写入保持关闭。
9. 验证内部表零 CRUD，并使用两个 Project Session 验证 owner read、跨用户拒绝及 RPC actor。

PITCHETCH 的 schema dump、metadata export 和 Data Access snapshot 是应用侧验收证据，不上传到
Druvia API，也不进入 Druvia 仓库。

## 12. 实施计划

### Task 1：固定 provenance、状态和列授权契约

- [x] 为 managed/adoption/refresh/custom/recovery 状态写失败单元测试。
- [x] 为新增列默认零授权、删除列收紧和 capability 变化写失败测试。
- [x] 扩展 API/Admin 类型并实现纯函数 diff、digest 和 permission 规范化。
- [x] 保持现有 `columns` 和逻辑 policy 字段兼容。

### Task 2：增加 migration 023/024 与 repository

- [x] 新增 managed policy、operation 和 table deletion outbox up/down migration。
- [x] 增加不可变 payload、状态转换、活动操作唯一性和 down guard 测试。
- [x] 增加 inflight/recovery `BEFORE DELETE` guard、项目 cascade 和稳定 constraint 映射测试。
- [x] 增加 baseline/operation repository 及数据库集成测试。
- [x] 将 migration CLI 与 release migration ceiling 更新到 24。

### Task 3：实现 adoption

- [x] 先覆盖无基线、空权限、受支持旧规则和真实 custom 的失败测试。
- [x] 实现 adoption preview/apply、digest 复核和幂等返回。
- [x] 证明 adoption 不发送 Hasura 写请求、不接管 legacy/external role。
- [x] 证明 wildcard 不能进入 baseline，且 digest 不把 wildcard 归一为当前显式列数组。

### Task 4：实现 policy update provenance

- [ ] 为首次配置、保留既有 grants、`all <-> owner`、active mode 切换和 owner column 变化写
  失败测试。
- [ ] 覆盖两个管理员交错提交、缺失/过期 expected revision 和数据库条件更新失败。
- [ ] 覆盖相同 operation ID 同 payload 的响应丢失重试、不同 payload 冲突及新 operation 的
  verified no-op。
- [x] 将普通 PUT 接入 policy operation 状态机。
- [ ] 验证 Hasura 成功但基线写入失败时恢复 source，不留下无 provenance target。

### Task 5：实现 reconcile 与恢复

- [ ] 为 preview stale、baseline revision drift 和 metadata custom drift 写失败测试。
- [x] 实现 operation-specific target grants 的服务端重物化。
- [x] 实现 apply、target 验证、source 恢复和 recovery-required gate。
- [ ] 注入 bulk 中途失败、进程恢复状态和重复 apply，验证幂等与恢复。
- [ ] 覆盖 apply 后进程终止、新客户端重新发现 operation 并 recover 的路径。
- [x] 注入 target 已验证后的未知 COMMIT 结果，覆盖 committed、not committed 和 uncertain 三态。
- [ ] 注入 target 已验证后的 baseline update/trigger 失败，验证确认后再完成或恢复。
- [x] 注入 bulk 发出后数据库锁连接断开、recover 接管和旧 bulk 迟到完成，验证 resource version
  与 writer epoch fencing。

### Task 6：贯通 overview、DDL 和管理锁

- [x] overview 区分待配置、结构变化、接管、自定义和恢复。
- [x] migration 019 与 policy operation 活动状态双向互斥。
- [x] DDL、raw SQL、Realtime、表/项目删除和 clean restore 遵守 recovery gate。
- [x] 表删除以 migration `024` outbox 协调 PostgreSQL/Hasura，schema 生命周期正确处理受管基线。
- [x] 项目删除在任何外部破坏动作前执行 operation preflight，并由数据库 delete guard 兜底。

### Task 7：实现 Admin 管理体验

- [x] 增加状态标签、adoption 确认、reconcile 列差异和阶段进度测试。
- [x] 实现默认不选新增列的复选列表和不可授权列状态。
- [x] 普通编辑器提交 effective grants，防止无关变更扩大字段权限。
- [x] 恢复失败时收口为唯一恢复入口。

### Task 8：真实 PostgreSQL + Hasura 验证

- [x] 在旧表/旧基线后执行 ALTER TABLE ADD COLUMN，验证 `refresh_required`。
- [x] 验证新增列默认不读不写，显式 select 后只增加读取。
- [x] 验证 owner、anonymous、generated/identity 和 custom preservation；跨用户由应用侧继续。
- [x] 验证 `bulk_atomic` 与 Hasura v2.48 `bulk` fallback 的 target/source digest。
- [x] 验证 v2 export/resource-version CAS、空 source 同值 table-customization fence，以及列删除后
  受控 `replace_metadata` 只修复目标 scoped permissions。
- [ ] 在第二次 source check 前注入外部 metadata 修改，验证不发送 drop/create；记录直接 Hasura
  写入必须使用静默窗口的运维边界。
- [ ] 覆盖 apply/recover 在 writer epoch 持久化前和持久化后分别崩溃的状态转换。
- [ ] 验证二次 preview/apply 为 no-op，失败恢复无残留记录或 permission。

### Task 9：PITCHETCH 本地验收与文档同步

- [x] 按第 11 节完成 `football_session` adoption 和显式 managed policy update。
- [ ] 由 PITCHETCH 继续 M4 四张派生表和双 Session 验收。
- [x] 更新最近的 API/Admin `AGENTS.md`、设计决策、progress 和发布迁移前置条件。
- [x] 执行 Data Access、migration、API、Admin 定向与生产构建验证。
- [x] 完成 critical review，修复至无 Critical/High/Medium finding。

## 13. 验收标准

1. 已有受管基线的表新增列后显示 `refresh_required`，不再误报 custom；PITCHETCH 当前没有旧
   基线，因此先显示 `adoption_required`。
2. 没有 provenance 的显式列规则必须先 adoption，且 adoption 不修改 Hasura；wildcard 规则
   不能被 adoption。
3. 两个 M4 列只在管理员显式选择后进入 authenticated select。
4. 两个 M4 列不进入 insert/update，Project Session 不能直接写入。
5. 已保存 row owner、preset、关闭 update/delete 和 anonymous 关闭状态保持不变。
6. 真实 custom、legacy 和其他 role permission 不被覆盖。
7. preview 后任一 source、Schema 或 revision 漂移都返回 409；已有基线上的普通 PUT 缺失或
   使用过期 revision 同样返回 409。
8. 正常 apply 和失败恢复均重新导出 metadata 并验证 digest。
9. 无法恢复时持久化 recovery gate，相关管理写入不能继续。
10. 普通 PUT 不会因无关逻辑策略修改扩大既有列授权。
11. 重复 adoption、preview、PUT/apply 和 recover 具有明确幂等结果；PUT 响应丢失后使用相同
    operation ID 返回原完成结果，API/Admin 重启后仍可发现并恢复未完成操作。
12. Admin 不暴露物理 role、原始 metadata、凭据或内部完整 digest。
13. migration 023 在有基线或操作记录时不能 down，活动/恢复记录也不能被项目 cascade 删除；
    migration 024 在 pending deletion 存在时不能 down。
14. PITCHETCH 四张派生表 owner-select、内部表零 CRUD 和双 Project Session 矩阵通过。

## 14. 发布与回滚

- API 与 Admin 必须使用包含同一契约的镜像一起发布。
- migration `023`、`024` 必须先于新 API/Admin 启动，release manifest migration ceiling 不得低于 24。
- GHCR、自建 Registry、本地 release 演练和生产 OTA 使用同一 migration 前置条件。
- OTA 只升级 Druvia 平台程序和平台 migration，不自动 adoption/reconcile 任何项目业务表。
- migration up 只新增 `public` 平台控制记录，不修改业务 schema、业务数据或现有 Hasura permission。
- migration down 仅允许不存在 managed baseline 和 operation 记录的环境；生产使用后采用新编号前向修复。
- PITCHETCH 本地验收完成不代表生产发布完成，stable manifest 仍需通过既有应用兼容回归和人工
  apply 门禁。

## 15. Review 与进度

- 2026-09-06：确认根因是 inspection 以当前全量列做精确匹配，而系统没有持续 provenance；
  本地确认 `football_session` 当前旧权限未包含两个 M4 新列，运行态没有扩权。
- 2026-09-06：确认 PITCHETCH 为 explicit 项目且 migration 019 无对应记录，不能自动复用旧迁移
  snapshot。
- 2026-09-06：用户选择“持久化受管基线与独立 reconcile 状态机”方案。
- 2026-09-06：用户确认新增列默认不加入 select/insert/update，必须在 reconcile 中显式授权。
- 2026-09-06：用户逐节确认数据模型、API 状态流、失败恢复、Admin、测试和发布边界。
- 2026-09-06：critical review 首轮发现 wildcard、active mode 切换、PITCHETCH adoption 后状态、
  崩溃恢复发现和删除保护五项重要缺口；已修正设计，等待下一轮 review。
- 2026-09-06：critical review 第二轮发现 stale Admin 写入、最终数据库事务失败和外部 Hasura
  写入竞态三项重要缺口；已增加 expected revision、未知 commit 判定、二次 source check 与运维
  静默窗口，等待下一轮 review。
- 2026-09-06：critical review 第三轮发现锁连接丢失后的迟到 Hasura 请求、PUT 响应丢失重试和
  静默窗口保证表述三项重要缺口；已根据 Hasura v2.48 Metadata API 能力增加 resource-version
  fencing、writer epoch/deadline、PUT operation ID，并明确直接 admin-secret 写入不受支持，等待
  下一轮 review。
- 2026-09-06：critical review 第四轮发现空 source 全量 replace 风险、writer epoch 持久化时序和
  resource-version 改造范围三项重要缺口；已改为受限 table-customization fence、发送前原子落库，
  并将 CAS 约束收窄到本功能 policy-operation，等待下一轮 review。
- 2026-09-06：critical review 第五轮未发现剩余 Critical、High 或 Medium finding；文档 review
  循环结束。真实 Hasura v2.48 table-customization fence、迟到 bulk、未知 COMMIT、epoch 崩溃点和
  PUT 响应丢失仍是实施阶段必须通过的验证门禁。
- 2026-09-07：完成 migration 023、受管 baseline/operation、adoption、普通 policy update、
  reconcile/recover、Admin 状态流、release migration ceiling 和文档同步；PITCHETCH
  `football_session` 已完成 adoption，并仅显式授予两个 M4 新列 authenticated select。
- 2026-09-07：实施期首轮 critical review 发现 timeout 迟到写、非原子 bulk fallback 部分成功、
  历史 capability 恢复验证和进程崩溃后恢复入口四项重要问题；已改为未知结果恢复 gate、历史能力
  重解析和过期操作派生恢复状态，并新增回归测试。当前等待实施期第二轮 critical review。
- 2026-09-07：实施期第二轮 critical review 发现恢复失败成功提示、无关 inconsistent metadata、
  Admin PUT operation ID、表删除事务和 release test gate 五项 Medium 问题；已逐项修复并增加
  controller/Admin/真实 Hasura 回归，等待下一轮 review。
- 2026-09-07：实施期第三轮 critical review 发现 Admin 在响应丢失后只保留 operation ID、完成操作
  重放可能返回后续 baseline，以及 release gate 未强制真实 PostgreSQL/Hasura 集成三项 Medium
  问题；Admin 已改为保留同一完整不可变请求体，服务端仅对仍为当前 target 的完成操作返回幂等
  成功，stable release 新增独立 PostgreSQL 17 + Hasura v2.48 必需集成 job。等待下一轮 review。
- 2026-09-07：实施期第四轮 critical review 发现 writer claim 前崩溃、owner 能力收缩无操作路径、
  owner preset grant provenance、completed replay TOCTOU 四项重要问题；另指出的 release secret
  实际可由 test setup 间接注入，但仍改为 workflow 显式契约。当前已将第二次 source check 前移到
  `preview_ready`，一次性 claim writer/deadline，并为无 deadline 历史 orphan 增加 35 秒恢复判定；
  reconcile 支持受限 target policy 与 owner 安全收紧，grants 在持久化前规范化，completed replay
  在项目锁内验证并读取状态。真实 PostgreSQL/Hasura 已覆盖 owner 删除、generated always 和
  identity always。等待下一轮 review。
- 2026-09-07：实施期第五轮 critical review 发现无 deadline direct recover 绕过静默窗口、
  reconcile 可更换 owner column、表删除先 untrack 后数据库失败三项重要问题；recover API 已复用
  deadline/orphan 安全时间并在时间戳缺失时失败关闭，reconcile 仅允许保留原 owner 或收紧，表删除
  改为 PostgreSQL 表/元数据/baseline 同事务提交后再执行可重试 Hasura untrack，真实 untrack 错误
  不再吞掉。等待下一轮 review。
- 2026-09-07：实施期第六轮 critical review 发现非默认 schema 删除可能误删默认 baseline、临时
  Hasura 故障后删除恢复依赖重启、fallback writer fence 错误被误报为未知写入，以及 prerelease
  可能覆盖 stable latest 四项重要问题；已加入 schema 精确删除、migration 024 持久 outbox 与运行期
  重试、fallback 前独立 lease 校验，并由 SemVer 后缀约束 GitHub prerelease。等待下一轮 review。
- 2026-09-07：实施期第七轮 critical review 发现 operation 未持久化 schema 身份、migration down
  guard 存在检查/删除竞态、outbox 恢复可能无限等待且依赖错误文字、Hasura 5xx 被误判为确定性拒绝，
  以及无关项目 outbox 阻断全局管理写入。已将 operation schema 设为不可变并在 apply/recover 失败
  关闭；down guard 改为 ACCESS EXCLUSIVE lock；outbox 改用有界 v2 export 做结构化确认且只阻断同
  scope；Hasura metadata 错误按 typed 4xx/未知结果分类，并增加对应回归。等待下一轮 review。
- 2026-09-07：实施期第八轮 critical review 发现恢复会覆盖已观察到的第三方 scoped permission、
  pending 删除可能 untrack 外部同名重建表，以及无效手工版本在镜像 push 后才失败。恢复现只接受
  source/target/命令前缀状态；outbox 在 Hasura 调用前确认 PostgreSQL relation 仍不存在；release
  版本和 channel 由统一严格 SemVer 解析器在 Registry 登录前预检，并增加单元与真实故障注入。
  等待下一轮 review。
- 2026-09-07：实施期第九轮 critical review 未发现 Critical/High，发现 baseline 数据库唯一键未包含
  schema、任意预发布后缀被错误归入 beta、relation check 与 untrack 间仍可由直接 SQL 重建三项
  Medium 问题；已将 baseline 主键与 repository 统一为 `project + schema + table`，严格限定
  prerelease 首段，并由 migration `024` event trigger 在 pending 期间保留 relation 名称。等待最终
  critical review。
- 2026-09-07：实施期第十轮 critical review 仅发现未知 COMMIT 三态和旧 writer 迟到缺少可执行
  故障注入这一项 Medium 问题；已增加 committed/not committed/uncertain 三态测试，以及锁连接失效、
  recover 接管后旧 resource-version writer 迟到被拒绝且不能覆盖恢复结果的并发测试。该测试文件已在
  release workflow 的镜像 push 前门禁中运行。
- 2026-09-07：实施期第十一轮 critical review 发现 prerelease 仍接受 `beta.rc.1` 等混合后缀，且
  未知 COMMIT 与旧 writer 迟到测试未完整经过公共业务路径两项 Medium 问题；现已限定 `beta` /
  `nightly` 后续标识只能为数字，COMMIT 三态均从完整 policy update 路径注入连接故障，迟到 writer
  测试以断开的旧数据库连接和状态化 Hasura resource-version CAS 证明恢复结果不会被覆盖。
- 2026-09-07：最终 critical review 未发现剩余 Critical、High 或 Medium finding；实施期 review
  循环结束。生产 GitHub Actions、Registry push 和 OTA 演练仍按第 14 节作为独立发布验证，不属于
  本地实现完成证据。
- 当前验证：完整单元回归 145 个测试文件、1016 个测试通过；
  API/Admin production build 通过；
  当前活动 PostGIS `127.0.0.1:5632` 与 Hasura v2.48 的真实 generated/identity、列新增/删除、
  adoption/reconcile、保留无关 inconsistent object 的受控 metadata replacement，以及两类表删除
  outbox 崩溃及同名重建窗口共 7 个集成用例通过。根
  `.env` 仍指向普通库 `5532`，运行真实集成测试时必须显式指定活动 PostGIS 端口。baseline
  update/trigger 失败和真实进程崩溃点仍需完成故障注入；PITCHETCH 应用侧四张派生表、双 Session
  和生产发布均不属于已完成证据。
