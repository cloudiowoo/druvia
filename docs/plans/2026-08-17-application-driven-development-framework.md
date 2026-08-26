# Druvia 应用驱动的未来开发框架

日期：2026-08-17

状态：已采纳并执行中的方向框架。具体能力仍需独立设计、实施计划、当前代码验证和真实应用验收。

## 1. 文档定位

本文在 `2026-08-14-project-update-direction-analysis.md` 的现状评估基础上，定义 Druvia 后续如何由真实应用推动平台演进。

两份文档职责不同：

- `2026-08-14-project-update-direction-analysis.md`：记录当前能力、风险、发布现状和生产加固路线。
- 本文：定义未来需求如何分层、何时进入 Core、如何通过参考应用验证，以及各阶段的开发门槛。

本文不是具体功能的实施计划。进入编码前，仍需为每个独立能力编写设计与实施计划，并以当前代码和测试重新核实现状。

### 1.1 2026-08-19 执行快照

本文定义长期治理和依赖顺序，不以单个版本或一次发布作为“全部完成”条件。当前执行状态为：

- Phase A 的主要 Core 实现已落地：安全默认 permissions、显式表权限、旧项目迁移控制面、GraphQL/Realtime actor、RPC/Functions actor、直接 Storage Project User 授权和 MCP 实验性收口均已完成对应代码切片。
- Phase A 尚未关闭：真实 taro-app 尚未按最新契约完成 Project Auth、GraphQL、Realtime、Storage、RPC 和 Functions 全链路验收；根级 build/lint/核心测试与 release 必过门禁也未完全统一。
- Phase B 仅部分完成：双 Registry、digest manifest、Compose-native OTA 和可选 PostGIS override 已具备；migration metadata 自动生成、当前基线的升级/恢复演练和 Trusted Backend 生命周期仍未闭环。
- Phase C 尚未进入产品化验收：taro-app 的真实兼容矩阵、足球应用、Swift SDK 候选和 Recipe 候选均未完成。
- Phase D 尚未开始，并继续保持证据驱动，不因 taro-app 上线而提前建设通用 Queue、Worker Runtime 或商业化能力。

当前主线调整为“taro-app 优先上线验证”：不等待 Phase B-D 全部完成，以真实 taro-app 暴露并修复上线阻塞；足球应用和后续能力不作为 taro-app 的前置条件。

## 2. 背景与目标

Druvia 已经具备 Admin、API、Hasura、Storage、Project Auth、Realtime、Functions、SDK 和 Compose-native OTA 等真实实现；MCP 仅保留实验性原型。当前阶段的主要矛盾不是缺少功能入口，而是权限、身份、发布和恢复能力尚未形成一致的生产闭环。

与此同时，真实应用开始提出更具体的需求：

- `taro-app` 迁移验证 Supabase 兼容、微信登录、H5/小程序、Project Auth、Storage 和 Realtime。
- 足球运动数据应用验证 Apple 平台客户端、离线采集、批量同步、高频原始文件、后台分析和可选地理能力。

未来开发框架的目标是：

1. 用真实应用暴露 Druvia 的通用缺口。
2. 避免把单一应用的领域复杂度写入平台 Core。
3. 让可选能力有标准解法，但不增加默认部署重量。
4. 通过明确门槛决定能力何时从应用实现晋升为平台能力。
5. 保持权限安全、迁移兼容、发布可靠性和自托管可维护性优先。

## 3. 总体原则

### 3.1 应用负责验证，平台负责抽象

应用开发首先使用 Druvia 已有能力完成端到端流程。只有现有能力无法安全、稳定或可维护地解决问题时，才提出平台改动。

平台改动应解决可复用的能力缺口，不复制应用的数据模型、算法和运行时。复杂应用能够以少量 Core 能力加应用自身扩展完整运行，才是 Druvia 作为轻量 BaaS 的有效证明。

### 3.2 安全基础不适用“第二个应用”门槛

通常情况下，一个能力至少被两个不同类型应用自然需要，才考虑进入 Core。但以下基础问题发现后应直接修复：

- 身份传播不一致。
- 默认权限过宽。
- 凭证无法撤销或审计。
- 数据恢复和升级边界不可靠。
- 公开接口契约与实际行为不一致。

这些问题属于平台正确性，不需要等待第二个应用证明。

### 3.3 默认运行时保持轻量

新的数据库扩展、队列、日志后端、分析服务和 Worker 运行时不得直接成为默认依赖。优先通过配置入口、Compose profile、override、Recipe 或外部进程提供。

### 3.4 先稳定服务端契约，再扩展多语言 SDK

SDK 应降低客户端接入成本，但不能反向固化尚未闭环的服务端语义。Project Auth、GraphQL actor、Realtime、Storage 和错误契约稳定后，才适合发布承诺兼容性的官方新语言 SDK。

## 4. 三层能力模型

### 4.1 Druvia Core

Core 负责所有应用都应依赖的安全和基础能力：

- 项目、Schema 和环境管理。
- Project Auth 与统一 actor 契约。
- Hasura GraphQL 和 permissions。
- Storage、Realtime、Functions、RPC。
- Trusted Backend 的凭证与受控能力签发。
- 管理 API、Admin、SDK 基础契约。
- migration、发布门禁、双 Registry 和 OTA 恢复。
- 结构化日志和必要审计字段。
- `platform_user / project_user / apikey / trusted_backend` 的身份边界，以及允许进入数据面的身份到 Hasura role/session variables 的显式映射。Trusted Backend Key 本身不作为 Hasura actor，只能通过受控签发能力进入后续链路。

Core 不包含具体应用的数据模型、分析算法或后台任务定义。

### 4.2 Optional Capability / Recipe

这一层提供可复用但不应默认启用的标准解法：

- PostgreSQL 自定义镜像和扩展部署方式。
- PostGIS Compose override 与 migration 示例。
- 基于 PostgreSQL 表和 `FOR UPDATE SKIP LOCKED` 的任务模式。
- Python Trusted Backend Worker 示例。
- 可选日志栈和特定存储 adapter 的部署说明。

Recipe 必须来源于已运行的应用实践，包含版本前提、配置、失败处理、测试方式和卸载边界。未经验证的设计不应仅为补齐功能清单而建立 Recipe。

### 4.3 Application Domain

应用层保留领域复杂度，包括：

- 足球场地、比赛、传感器会话和分析任务数据模型。
- GPS、心率、IMU 数据协议和离线缓存。
- Peak 3s、冲刺、热力图、疲劳和恢复算法。
- Python 分析 Worker 及其任务领取策略。
- 原始数据格式、派生指标、算法版本和重新计算。
- 特定客户端的交互、同步策略和错误恢复体验。

## 5. 双参考应用验证模型

### 5.1 taro-app 迁移场景

主要验证：

- Supabase 风格 API 的接口和行为兼容。
- 微信登录、Project Session 恢复和 refresh。
- H5/小程序环境中的 token 选择和 Storage 上传。
- GraphQL、RPC、Functions 和 Realtime 重连。
- 迁移文档、兼容矩阵和必要适配器。

### 5.2 足球运动数据场景

主要验证：

- 原生移动端 Project Auth 和 session 生命周期。
- 离线采集后通过 GraphQL 批量写入 GPS/心率数据。
- 高频 IMU 压缩文件上传和幂等重试。
- Project User 对比赛、轨迹和分析结果的行级隔离。
- Python 后台分析的受控身份、用户归属和审计链路。
- 可选 PostgreSQL 扩展和非 Node.js 客户端接入。

### 5.3 共同验收价值

两个场景共同验证的能力，应优先形成稳定平台契约：

- 同一个 Project Session 在各模块中的身份一致性。
- 客户端 session 存储、刷新和失效处理。
- 用户级 GraphQL 和 Realtime 权限。
- Project User 与匿名 API Key 不会被折叠成同一数据角色。
- Storage 对象归属、上传授权和审计。
- Functions/RPC 的调用身份和错误语义。
- 从开发环境到 release-mode OTA 的可重复发布流程。

## 6. 能力进入平台的决策门槛

每个新需求应依次回答以下问题：

1. 现有 Core 是否已经能够安全完成，只是应用尚未正确使用？
2. 问题属于平台正确性、安全性或发布可靠性吗？
3. 除当前应用外，是否有第二个不同类型应用自然需要？
4. 能否以更小的配置入口、SDK helper 或 Recipe 解决？
5. 加入默认运行时会增加多少资源、升级和恢复成本？
6. 是否已有端到端实现、失败数据和性能证据？
7. 能否定义稳定契约、兼容策略和自动化验收？

据此采用以下归属规则：

| 判断结果 | 归属 |
| --- | --- |
| 身份、权限、凭证、数据安全或发布正确性问题 | Core，立即修复 |
| 多类应用都需要且可以保持稳定轻量 | Core 或官方 SDK |
| 通用但非所有部署需要 | Optional Capability / Recipe |
| 只有当前应用需要，或算法和数据模型高度领域化 | Application Domain |
| 尚无运行证据，主要来自功能对标 | 暂缓 |

## 7. 当前能力评估与建议归属

| 能力 | 当前判断 | 方向 | 优先级 |
| --- | --- | --- | --- |
| Project User 全链路身份 | GraphQL、Realtime、RPC、Functions 和直接 Storage 已完成 actor 切换；待真实应用联合验收 | Core | P0 验收 |
| Hasura 默认权限 | 新表安全默认值、显式表权限和旧项目受控迁移已实现 | Core | 已实现，待应用验收 |
| 跨模块 actor 契约测试 | 分模块和真实服务测试已增加；仍缺 taro-app 驱动的统一端到端矩阵 | Core | P0 验收 |
| 发布质量门禁 | release workflow 已有定向回归、Deno check、SDK build、镜像 digest；根级 build/lint/核心测试门禁仍不足 | Core | P0 |
| OTA 恢复门禁 | 更新链路已有，故障和数据库恢复演练不足 | Core | P1 |
| PostgreSQL 扩展部署 | 默认镜像保持不变；PostGIS overlay 已覆盖 local/prod/release 渲染和已有数据库显式启用路径，镜像升级仍由运维管理 | Optional deployment capability | 已实现基础路径，待应用验收 |
| Trusted Backend 生命周期 | 有 key/scope/last-used，删除为硬删除，缺少完整过期、可审计撤销和轮换 | Core | P1 |
| Swift 客户端 | 仓库尚无实现，服务端契约仍在稳定 | 应用内实验，成熟后官方 SDK | P2 |
| PostGIS | 足球场景有价值，但不是通用默认依赖 | Optional Recipe | P2 |
| GraphQL 批量写入 | Hasura 和现有 SDK 数组 insert/upsert 已可使用 | 先由应用验证 | 无需新服务 |
| 后台分析任务 | 单个分析场景可由应用表实现 | Application，成熟后 Recipe | P2 |
| Resumable Upload | 当前没有失败率和文件规模证据 | 暂缓 | Evidence-based |
| Queue / Worker Runtime | 当前只有单一 Python 分析场景 | 暂缓 | Evidence-based |
| TimescaleDB / PostGIS Manager | 不属于当前必要能力 | 不实施 | - |

## 8. 分阶段开发框架

以下 `0.4.0 / 0.4.x / 0.5.x` 是与 2026-08-14 评估保持一致的目标区间，不是已经确认的发布承诺。仓库当前产品 release、根 package 和各 workspace 仍有不同版本轴；具体版本归属必须在实施计划中重新确认。Phase A-D 主要表达依赖顺序。

### Phase A：0.4.0 生产安全基线

目标是完成现有能力的安全闭环，不增加新的重型平台服务。

- 收紧 Hasura 自动 permissions，默认拒绝匿名写入和无过滤 CRUD。
- 为现有项目生成权限清单和迁移方案：识别历史自动权限与用户自定义权限，先备份/预览再清理，不得用新默认值直接覆盖已审查的自定义规则。
- 定义统一 project actor，覆盖 HTTP、WebSocket、Worker helper 和日志；明确 actor type、project id、project user id、业务 role 和可信来源。
- 显式定义 actor 到 Hasura role/session variables 的映射，Project User 与 API Key 不得继续共用无用户标识的 `user` role。
- 定义应用表所有权字段与 Project User `sub` 的类型和权限约定，确保行过滤可以实际落地。
- 提供显式 permissions 声明、同步和验证路径；安全默认值只负责拒绝未配置访问，不能让应用依赖管理凭证才能恢复正常读写。
- 打通 Project User 在 GraphQL、Realtime、Storage、RPC 和 Functions 中的身份传播。
- 为 Realtime 选定一个正式鉴权路径：使用受控 WebSocket 代理，或签发 Hasura 可验证且包含所需 claims 的 Project JWT；不得以匿名连接成功作为验收。
- 为 API Key、Project User、Platform User、Trusted Backend 建立互斥授权测试。
- 修正 MCP 认证和路由契约，或继续明确标记实验性。
- 建立 build、lint、核心测试和 release 必过门禁。

阶段出口：新建业务表不再自动获得匿名写入或无过滤 CRUD；已有项目完成宽权限盘点并具备可回退的清理路径；同一 Project User 在五条数据/执行路径中具有一致身份、适用的行级限制和审计信息；参考应用可通过显式 permissions 工作，不需要管理凭证绕过项目权限。

当前判断：前两项和五条路径的代码基础已基本完成，MCP 已选择保持实验性；真实 taro-app 验收和统一 release 质量门禁未完成，因此 Phase A 仍为“实现接近完成、阶段出口未通过”。

### Phase B：0.4.x 发布可靠性与扩展入口

- 自动生成并校验 migration metadata。
- 完成双 Registry 独立发布策略和上一稳定版 OTA smoke test。
- 演练镜像失败、迁移失败、健康检查失败和数据库恢复。
- 使用 Compose 原生 PostGIS override 覆盖 local/prod/release；默认仍为 `postgres:17-alpine`，数据库镜像与扩展不进入普通 OTA 自动切换。
- 完善 Trusted Backend 的过期、撤销、轮换和审计。

阶段出口：平台扩展不破坏 local/prod/release 一致性，OTA 不会隐式切换数据库基础镜像。

taro-app 上线不要求 Phase B 全部完成，但以下生产相关子集不可跳过：目标环境备份、migration `018 -> 020` 适用性确认、一次生产同构部署/健康检查/恢复演练、可靠的单一 Registry 路径和固定 digest。PostgreSQL 扩展、完整双 Registry 演练和未被 taro-app 使用的 Trusted Backend 能力可以继续延期；若 taro-app 生产直接使用 Trusted Backend Key，则其过期、撤销、轮换和审计必须提前完成。

### Phase C：0.5.x 双应用验证与 SDK 产品化

两个参考应用可以在 Phase A/B 期间进行开发环境验证。Phase C 的含义是完成兼容声明、官方 SDK 和 Recipe 的产品化，不要求应用开发等到 0.5.x 才开始。

- 用 taro-app 完成 Supabase 迁移兼容矩阵。
- 用足球应用完成原生客户端、离线批量、Storage 和 Python Worker 验证。
- 对两个场景共同暴露的契约问题进行 Core 修正。
- 将足球应用内已稳定的轻量客户端提取为 Swift SDK 候选。
- 将跑通的 PostGIS、Python Worker 和 SQL Jobs 整理为 Recipe 候选。

阶段出口：每项对外兼容声明都有真实应用、自动化测试或可重复演练证据。

### Phase D：证据驱动的扩展与商业化

- 第二个后台任务场景出现后，再评估通用 Jobs 或 Queue。
- 大文件上传失败数据达到明确阈值后，再评估 resumable upload。
- 在真实运维数据基础上决定更重的 Registry、审计和备份能力。
- 推进企业多租户、SLA、商业授权和受支持部署矩阵。

## 9. 足球应用的推荐最小接入路径

足球 MVP 不应等待 Druvia 新增完整平台服务，可按以下方式接入：

1. GPS 和心率按 1 Hz 存入 PostgreSQL，通过 Hasura 数组 mutation 分批提交。
2. 截至本文日期，GraphQL 代理请求体限制为 1 MiB；实施时应重新核对当前代码，并通过真实数据测量批大小。
3. 截至本文日期，Storage 上传限制为 50 MiB；高频 IMU 应采用压缩和幂等分块，并在实施时重新核对限制。
4. 使用应用自己的 `analysis_run` 表表示 pending/running/completed/failed。
5. Python Worker 可通过 Trusted Backend 为目标用户签发标准 Project Session，再执行用户范围内的读写；任务发现和领取仍由应用设计。
6. 原始数据与派生指标分离，派生结果记录算法版本并支持重新计算。
7. 热力图和轨迹分析优先由 Python 完成；只有查询需求证明必要时才启用 PostGIS。

该路径用于验证平台契约，不意味着这些领域结构进入 Druvia migration 或 Admin。

Trusted Backend Key 当前只用于签发 Project Session 或 Storage Ticket，不能直接作为 GraphQL、数据库或 Storage 对象操作凭证。Trusted issuer 返回的是包含 access token 和 refresh token 的标准 Project Session，不是专用短期 Worker 凭证；Worker 必须按高敏感凭证保护，并避免无必要地持久化 refresh token。若应用需要跨用户发现任务，应先采用应用自有的受控入口或数据库角色，并以实际使用证据评估是否需要新的平台级 scope。Trusted Backend 完成过期、可审计撤销和轮换前，只用于受控开发验证，不作为足球 Worker 的生产就绪结论。

## 10. SDK 与 Recipe 晋升策略

### 10.1 Swift SDK

第一阶段在足球应用内实现轻量客户端，只封装：

- Core HTTP 和统一错误解析。
- Project Auth、session 持久化与 refresh。
- Storage 上传下载。
- Functions 调用。
- GraphQL 交由成熟客户端库处理。

满足以下条件后，可从应用内封装晋升为官方实验性 SDK 候选：

- Project User 服务端契约已经稳定。
- 登录、刷新、上传、GraphQL 和错误处理完成真实设备验证。
- 有契约测试覆盖服务端版本兼容。
- 明确模块化边界和版本策略。

进入 `Stable` 还必须满足：

- 至少有第二个独立 Swift 集成完成核心流程，或有等价的跨版本兼容测试矩阵证明其不依赖足球应用内部假设。
- 明确维护责任、支持的 Druvia 版本范围、弃用周期和发布流程。
- SDK 发布失败不会阻断 Druvia 服务端 release，服务端与客户端版本轴保持独立。

### 10.2 Recipe

Recipe 发布前必须包含：

- 支持的 Druvia、PostgreSQL 和依赖版本。
- local/prod/release 配置差异。
- migration、备份、恢复和升级方式。
- 最小工作示例与自动化 smoke test。
- 安全边界、凭证要求和已知限制。

## 11. 发布与兼容性约束

应用驱动的新能力不得绕过现有发布模型：

- Phase 表示能力依赖和成熟度，不等于生产发布批次。main 分支开发、Actions 构建、GitHub Release 和生产 OTA 是四个独立动作。
- taro-app 生产只接收通过其兼容回归的 `stable` release；updater 保持被动通知和人工 apply，不自动把后续 Phase 开发送入生产。
- 当前 release workflow 支持 `stable / beta / nightly` manifest channel，但 GitHub `releases/latest/download` 尚未为 beta/nightly 建立独立 prerelease/latest 隔离。使用该 latest URL 的生产环境期间，不得让 beta/nightly 发布覆盖其稳定入口；隔离方案需另行设计和验证。
- 发布镜像 tag 不得复用；生产实际应用继续固定 manifest 中的 digest。紧急 patch release 只包含生产故障、安全或兼容修复，不夹带无关 Phase 功能。
- 服务端至少兼容当前生产 taro-app 和下一待发布客户端版本。破坏性 API 变更必须经过弃用窗口；数据库变更优先使用 expand-contract，不能把镜像回滚等同于数据库回滚。
- 每个 taro-app stable 基线必须记录客户端版本、SDK 版本、Druvia release、migration 范围、备份要求、回滚边界和已验证流程。
- 数据库变更必须提供 migration、metadata 影响和回滚说明。
- PostgreSQL 扩展镜像属于部署配置，应显式固定版本或 digest，不由常规应用 OTA 静默切换；它也不属于当前 `api/admin/worker/updater` 应用镜像 manifest，必须独立制定升级和恢复步骤。
- Core 镜像继续通过 GHCR 和自建 Registry 两条完整 manifest 路径发布。
- SDK 变更必须区分接口兼容、行为兼容和迁移验证通过。
- 新 Recipe 必须验证从已有 release-mode 部署接入和移除的过程。
- 任何新增默认服务都必须给出资源成本、健康检查、备份和升级策略；缺少这些信息时不得进入默认 Compose。

## 12. 需求提案与治理

未来由应用提出 Druvia 改动时，设计文档至少记录：

- 真实用户流程和当前阻塞。
- 已尝试的现有 Druvia 能力及不足。
- Core、Optional 或 Application 的候选归属。
- 是否存在第二个独立应用场景。
- 权限、数据、迁移、发布和资源影响。
- 最小实现与明确不做事项。
- 自动化测试、真实应用验收和回退方式。
- 晋升、保持实验性或删除该能力的条件。

能力成熟度使用以下阶段：

1. `Application Experimental`：仅由应用维护，不承诺平台兼容。
2. `Recipe Candidate`：已有完整实现，开始整理部署和测试方式。
3. `Platform Candidate`：多个场景验证，契约和维护成本已明确。
4. `Stable`：进入正式兼容、发布和升级策略。

## 13. 近期执行建议

按当前项目状态，后续顺序应保持为：

1. 冻结 taro-app 上线依赖清单和版本基线，盘点真实表权限、Auth、GraphQL、Realtime、Storage、RPC、Functions 和部署依赖。
2. 在真实 taro-app/H5/小程序路径执行全链路验收，只修复实际阻塞上线的 Druvia Core 缺口，不横向扩展抽象 API 清单。
3. 补齐与本次 stable 基线直接相关的 build/lint/核心测试门禁，并清理或显式隔离会阻断确定性发布的既有失败。
4. 在生产同构预发布环境验证 migration、备份、部署、健康检查和恢复，再发布固定 digest 的 taro-app stable 基线。
5. taro-app 上线后按紧急 patch 或经过兼容回归的稳定批次升级，不按 commit 或 Phase 子任务反复更新生产。
6. 足球应用可以在开发环境使用现有 Core 开始 MVP，但不阻塞 taro-app 上线；记录所有绕行、失败和性能数据。
7. 在足球应用开发环境优先使用本地双库 overlay 验收 PostGIS：普通 PostgreSQL 保持默认基线，PostGIS 使用独立数据目录，显式切换 API/Hasura 后验证扩展、migration、metadata 刷新和数据库备份/恢复；生产仍按单库 PostGIS override 管理，只有真实运维证明现有模式不足时才修改 Core 配置。
8. 足球 Worker 进入生产前，完成 Trusted Backend 生命周期加固和凭证使用审计。
9. 服务端契约稳定后，再提取 Swift SDK 和已验证 Recipe；Jobs、Queue、Resumable Upload 和通用 Worker Runtime 继续保持证据驱动。

## 14. 框架验收标准

本框架得到有效执行，应表现为：

- 新需求都能明确归入 Core、Optional 或 Application。
- 安全和正确性问题不因“只有一个应用”而被推迟。
- 单一应用不再直接引入默认平台服务。
- taro-app 和足球应用共同使用同一套 Project User 契约。
- SDK 和 Recipe 只从已运行、可测试的实现中提取。
- 新能力进入 release 前具备 migration、测试、发布和回退证据。
- Phase B-D 的开发不会自动进入 taro-app 生产，生产升级只由通过兼容回归的 stable release 和人工 apply 触发。
- Druvia 默认部署依赖和资源占用不会因领域功能持续膨胀。

## 15. 当前明确不做

- 不建立足球专用 Sensor Ingest Service。
- 不建立 Druvia Analytics Service。
- 不建立通用 Worker Runtime 或 Worker Protocol。
- 不默认启用 PostGIS、Queue 或 TimescaleDB。
- 不在缺少真实失败数据时实现 resumable upload。
- 不为了单一 Swift 应用复制完整 GraphQL 客户端。
- 不把足球数据结构、算法或任务状态写入 Druvia Core。
