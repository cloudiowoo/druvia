# MCP 实验性状态收口设计与实施计划

日期：2026-08-19

状态：已完成

## 1. 目标

将现有 `@druvia/mcp-server` 的对外状态从容易被理解为已完成能力，收口为明确的实验性原型，避免用户或开发者将其用于生产环境。

本次不修复 MCP 的认证、路由、scope 或工具实现，也不新增平台凭证类型。后续只有在真实 AI 管理或项目数据访问场景提出明确需求后，才重新设计管理型或项目型 MCP。

## 2. 背景与现状

当前 MCP Server 通过本地 stdio 与 MCP 客户端通信，再调用 Druvia API。它注册了表列表、表结构、数据查询、数据插入、只读 SQL 和表资源读取能力。

现有实现不能视为正式可用：

- 启动身份使用项目 API Key，但实际调用的 schema、data 和 project query 路由属于平台管理能力。
- API Key 请求头、路由身份和 scope 没有形成一致契约。
- 缺少覆盖真实 Druvia API 的 MCP 契约测试。
- MCP 未接入官方 Compose、日志采集 profile、release 镜像或 OTA。
- 仓库没有一份包内使用说明明确以上限制。

`docs/plans/2026-08-17-application-driven-development-framework.md` 对此允许两种处理方式：修正 MCP 契约，或继续明确标记实验性。MCP 不是 taro-app 或足球运动数据参考应用的必要依赖，也不是 Phase A 阶段出口条件，因此当前选择后者。

## 3. 决策

### 3.1 保留实验代码

保留 `packages/mcp-server/src`，不删除原型。现有工具清单和 API 调用可作为未来重新设计时的需求输入，但不能作为当前可用性证明。

### 3.2 阻止误发布

在 `packages/mcp-server/package.json` 中：

- 将描述改为明确包含 `Experimental`。
- 设置 `private: true`，阻止按当前状态发布到 npm Registry。

`private: true` 不影响 monorepo 内安装、TypeScript 构建或后续本地研究；未来若要正式发布，必须在完成身份模型、契约测试和使用文档后显式移除。

### 3.3 建立包内状态入口

新增 `packages/mcp-server/README.md`，仅说明：

- MCP 在 Druvia 中的作用和 stdio 调用关系。
- 当前是实验性原型，不支持生产使用。
- 已知认证和路由不匹配。
- 不属于 Admin、SDK、Compose、release 或 OTA 运行链路。
- 当前不提供可复制的启动配置，以免把不成立的 API Key 流程包装成使用指南。
- 未来重新启动实现前必须先选择管理型或项目型身份模型。

### 3.4 同步当前状态文档

更新以下当前事实入口：

- 根 `AGENTS.md`：架构清单将 MCP 标为实验性；当前优先级不再要求立即修复 MCP，并增加不得宣称其生产可用的约束。
- `docs/progress.md`：当前快照和下一步移除 MCP 作为近期最高优先级及当前开发任务；记录其已收口为实验性原型。

不修改 2026 年 3 月的历史设计和实施文档；它们记录当时计划，不应回写为当前判断。不修改 `2026-08-14` 和 `2026-08-17` 两份方向文档，因为它们已经准确记录风险及“修复或保持实验性”的决策空间。

## 4. 非目标

- 不引入 `DRUVIA_ACCESS_TOKEN`、refresh token、邮箱密码登录或专用管理 key。
- 不修复 `X-API-Key` / `apikey` 请求头。
- 不改变 MCP tools、resources、SQL 校验或错误映射。
- 不增加 API 路由或调整现有路由授权。
- 不发布 npm 包、Docker 镜像或 GitHub Release 产物。
- 不接入 local、prod、release Compose 或 OTA manifest。
- 不为实验代码补写会暗示正式支持的运行教程。

## 5. 文件范围

| 文件 | 操作 | 责任 |
| --- | --- | --- |
| `packages/mcp-server/package.json` | 修改 | 标记实验性并阻止误发布 |
| `packages/mcp-server/README.md` | 新增 | 提供包内状态、边界和未来启用条件 |
| `AGENTS.md` | 修改 | 同步仓库级当前事实和优先级 |
| `docs/progress.md` | 修改 | 同步人类可读的里程碑和下一步 |
| `docs/plans/2026-08-19-mcp-experimental-status-closure.md` | 新增并持续更新 | 合并记录设计、实施步骤、验证证据和最终状态 |

## 6. 实施步骤

### Task 1：收口包元数据和包内说明

- [x] 在 `packages/mcp-server/package.json` 增加 `private: true`，并将 description 改为 `Experimental MCP server for the Druvia BaaS platform`。
- [x] 新增 `packages/mcp-server/README.md`，说明用途、当前限制、非运行链路和重新启用门槛。
- [x] 检查 README 不包含真实 token、API Key、生产域名或可被误解为正式可用的启动命令。

### Task 2：同步当前项目状态

- [x] 在根 `AGENTS.md` 将 MCP 标为实验性原型。
- [x] 从根 `AGENTS.md` 的当前优先级中移除立即修复 MCP 的任务，并保留“契约完成前不得宣称生产可用”的稳定规则。
- [x] 在 `docs/progress.md` 记录实验性状态收口。
- [x] 从 `docs/progress.md` 的当前下一步移除 MCP 修复任务。
- [x] 保持真实应用验证、CI/release 门禁和延期的实际 OTA 演练安排不变。

### Task 3：验证和最终复查

- [x] 运行 `pnpm --filter @druvia/mcp-server build`，确认 `private` 和文档变更不影响包内构建。
- [x] 解析 `packages/mcp-server/package.json`，确认 JSON 有效且 `private === true`。
- [x] 搜索当前事实入口，确认不存在将 MCP 描述为生产就绪或近期必须修复的冲突表述。
- [x] 检查 `git diff --check`。
- [x] 将验证命令和结果写回本文档，并将状态更新为“已完成”。

## 7. 验收标准

1. 包元数据明确显示 MCP 为实验性且不可发布。
2. 包内 README 能让首次进入目录的开发者理解 MCP 的用途和当前不可用边界。
3. 根 `AGENTS.md` 与 `docs/progress.md` 不再把 MCP 修复列为当前开发优先级。
4. 方向文档仍保留未来恢复管理型或项目型 MCP 的选择空间。
5. 本次没有改变运行时代码、API 授权、Compose、release 或 OTA 行为。
6. MCP package 仍能完成现有 TypeScript 构建。

## 8. 后续重新启用门槛

只有满足以下条件时，才应为 MCP 建立新的独立设计与实施切片：

1. 有明确的 AI 客户端使用者和任务场景，而不是仅为了功能清单完整。
2. 先选择管理型 MCP 或项目型 MCP，不允许同一凭证模糊覆盖两种身份。
3. 明确凭证签发、过期、撤销、scope 和审计策略。
4. 每个工具与真实 API 路由、请求头和响应 envelope 一致。
5. 通过真实 API 契约测试后，才可以增加使用文档、发布包或部署入口。

## 9. 验证证据

实施日期：2026-08-19

- `pnpm --filter @druvia/mcp-server build`：通过。TypeScript 编译成功；仅出现仓库既有的 `apps/admin/package.json` workspace `pnpm` 字段警告。
- Node.js 包元数据断言：通过。`package.json` 可解析，`private === true`，description 与计划一致。
- 当前事实入口冲突扫描：通过。`AGENTS.md`、`docs/progress.md` 和包内 README 未将 MCP 描述为生产就绪或近期必须修复。
- 实验性状态正向扫描：通过。根规则、进度、包元数据和包内 README 均明确实验性边界。
- `git diff --check`：通过，无空白错误。
