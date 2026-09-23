# Data Access v2 环境限定授权投影设计与实施

状态：Druvia 本地实现与单测已完成；应用视图迁移、隔离联调和发布验收待完成
日期：2026-09-23

## 问题与隔离证据

PITCHETCH 的 `session_access_projection` 视图在读取时调用服务环境函数，函数依赖
`current_setting('hasura.user', true)`。Hasura CE v2.48.0 隔离测试证明：普通 SELECT 的
权限谓词能读取 `$1->>'x-hasura-druvia-service-environment'`，而视图中的 `hasura.user`
GUC 为空，触发 P0001，并对外呈现 HTTP 200 / `unexpected: database query error`。
此证据复现了 GLOBAL 的症状，但不是 GLOBAL 容器日志中的 SQLSTATE。

同一隔离测试证明 JSONB 视图列的 `_has_key: X-Hasura-Druvia-Service-Environment`
能分别按 `sandbox` / `local` 授权；不存在投影记录、错误环境、跨用户均无数据，缺少
环境 session variable 报错而不降级；投影视图自身无普通 role CRUD 或关系字段暴露。
临时 Postgres/Hasura 容器及网络均已清除，未触碰活动 Local/GLOBAL metadata。

## 冻结合同

1. 旧 `contractVersion: 1` / `policyVersion: 2`、v1 策略及其精确反向解析保持原样。
   新环境限定投影声明 `contractVersion: 2`，策略仍为 `policyVersion: 2`。
2. v2 合同在 `view` 增加 `environmentColumn`，必须是 `columns` 中声明的 `jsonb` 列；
   其余 view、relationship 字段与完整唯一键规则不变。拒绝未知字段、错误类型和版本混用。
3. v2 策略的 `selectConstraint` 增加受管 `environmentColumn`。固定物化谓词为
   `owner AND relationship(actor = X-Hasura-User-Id, allow = true,
   environmentColumn _has_key X-Hasura-Druvia-Service-Environment)`。
   环境 Header 由 Druvia 已有 Project Runtime Context 派生；调用方不得指定操作符或值。
4. JSONB 对象**仅包含当前环境被允许读取的键**，值固定为 `true`；`false` 键也会被
   `_has_key` 视为授权，故不能写入。PITCHETCH migration 的测试/verifier 必须显式覆盖
   `{"sandbox": false}` 不出现在授权视图、未获准环境不存在对应键；在这些证据完成前
   不得对该项目应用 v2 合同。Druvia 的静态视图 digest 无法证明业务计算的正确性。
   缺失/非法服务环境不得回退到 owner-only。
5. 新列及其类型、视图 definition、owner、安全属性、递归依赖、完整关系映射、权限原文
   与 baseline 一并进入现有 digest / drift / snapshot / recovery 管线；失配时整批失败关闭。
   不放宽系统函数依赖限制、不增加任意 SQL 或用户提供的 Hasura permission JSON。
6. 环境限定合同激活前及 apply 前必须确认项目级受管运行环境已启用，且涉及表的既有
   `anonymous.select` 全为 `false`；否则拒绝预检/应用，不能让匿名 role 绕过环境条件。
7. 已激活环境限定 baseline 时禁止使用 v1 投影合同重新覆盖；删除受管 runtime context
   必须与 Data Access apply/recover 共用项目 advisory lock，并在锁内拒绝仍被 baseline
   依赖的配置，或环境限定的 `applying / recovering / recovery_required` operation。
   target recovery 持久化 baseline 前再次检查环境，失效时整批 fail-closed；API 返回
   409，不进行删除或审计“已删除”。

示例合同只展示新增部分：

```json
{
  "contractVersion": 2,
  "policyVersion": 2,
  "view": {
    "name": "graphql_session_access_projection",
    "projectionMode": "sparse_allow_list",
    "key": ["session_id", "user_id"],
    "environmentColumn": "allowed_environments",
    "columns": {
      "session_id": "uuid", "user_id": "uuid",
      "can_read_basic": "boolean", "allowed_environments": "jsonb"
    },
    "clientPermissions": { "select": false, "insert": false, "update": false, "delete": false }
  },
  "relationships": [
    { "table": "football_session", "name": "graphql_session_access_projection",
      "type": "object", "mapping": { "id": "session_id", "user_id": "user_id" },
      "ownerColumn": "user_id", "actorColumn": "user_id", "allowColumn": "can_read_basic" }
  ]
}
```

正式九表合同由 PITCHETCH 维护；本例不预设其最终视图或关系名称。

## 应用边界

PITCHETCH 需要以项目 migration 从共同的环境授权计算中生成两种视图：RPC 快照保留
当前环境下的 `access_level` 语义；GraphQL 授权视图对每个 `(session_id, user_id)`
仅一行，按获准环境输出 JSONB keys，不依赖 `hasura.user`、应用自定义数据库函数或
跨 schema 关系。九表关系映射仍覆盖完整键。不能仅把原环境视图按各环境并集聚合，
否则 RPC 读取的 `access_level` 会混淆环境。PITCHETCH 负责 V26+ migration、
允许环境的业务含义、重复键检验及新机器合同；Druvia 不在此仓库修改该 DDL。

## Druvia 实施步骤

- [x] 为合同 v1/v2 验证、JSONB 列/环境列、未知字段与旧合同兼容增加先失败单测。
- [x] 扩展服务端合同解析和目录依赖校验；保留旧合同快照序列化稳定。
- [x] 为权限固定物化与反向识别增加先失败单测；实现严格环境谓词和 custom 拒绝。
- [x] 将 v2 合同经项目级 preview/apply/recover、baseline、状态和 Admin 导入类型贯通；
      覆盖环境缺失、匿名权限绕过、v1 降级、未终结 operation 的禁用锁、恢复时环境
      复核、digest / drift 的单测；
      通用 apply/recover 沿用已有测试。
- [x] 使用 opt-in 的独立 Docker/PostgreSQL/Hasura CE v2.48.0 集成测试验证本次
      **真实物化权限**的主键、列表、关系不暴露、投影视图零 CRUD、缺失环境、
      跨用户、`affected_rows`，不接触活动 metadata。
- [ ] 在应用新视图可用后运行九表真实平台 preview/apply/recover 与 drift 集成；
      当前仓库内的完整平台集成夹具仍只覆盖旧合同版本。
- [x] 运行定向 API/Admin 单测、API TypeScript 与 Admin 生产构建，复核文档与差异。

本地验证（2026-09-23）：定向 7 文件 104 单测通过；隔离 Docker/Hasura CE v2.48.0
测试 2/2 通过；API `tsc`、Admin `next build --webpack`、`git diff --check` 通过。
全量 `pnpm exec vitest run` 为 1749 通过、40 失败、180 跳过（20 文件失败）；
失败集中于当前未暴露的 Redis/Hasura 端口及活动测试库已有 schema/outbox 冲突，
**不能当作全量回归通过**。独立高风险代码复核未发现重要剩余问题；真实 PostgreSQL
上针对 runtime disable 的双分支查询、apply 写入 metadata 后与 disable/recovery
交错的并发测试仍待平台级集成补齐。

本地验证命令：

```sh
DRUVIA_RUN_HASURA_ENV_PROJECTION_INTEGRATION=1 \
  pnpm exec vitest run tests/integration/data-access-environment-projection-hasura.test.ts
```

该测试自行创建并清理隔离容器和网络；需要本地已有 `postgres:17-alpine` 与
`hasura/graphql-engine:v2.48.0` 镜像及可用的 Docker。它验证 Hasura 原生权限语义，
并不代替平台九表 preview/apply/recover 或 PITCHETCH 业务 migration 验收。

## 发布门禁

这次 Druvia 代码本身不修改 migration floor 或 release manifest。应用 migration、
完整九表合同、真实双 Project Session / 环境交替读取、RPC `access_level`、Realtime
路径及 Local/GLOBAL 数据库实际 SQLSTATE 的交叉验证尚未完成前，不宣称 PITCHETCH
商业读取已可上线；不得靠临时放宽 owner permission 或直改 Hasura metadata 绕过。
