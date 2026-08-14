# Druvia 项目更新方向评估

日期：2026-08-14

## 1. 目的

本文归档 Druvia 当前在应用能力、权限模型、SDK、MCP、Docker 发布和 OTA 更新方面的整体评估，并给出后续版本建议。

它是分析与路线建议，不替代：

- 当前代码和测试
- 根及子目录 `AGENTS.md` 中的工作约束
- `docs/agent/design-decisions.md` 中已确认的长期决策
- `docs/progress.md` 中的阶段状态

## 2. 总体结论

Druvia 已经跨过原型阶段，具备管理后台、管理 API、Hasura 数据层、Storage、Auth、Realtime、Functions、SDK、MCP 和 Compose-native OTA 的真实实现。当前主要问题不是缺少页面，而是多个能力尚未形成一致的生产安全闭环。

下一阶段不宜继续横向增加 provider 或管理页面，应优先完成以下闭环：

1. 权限默认值和项目终端用户身份传播。
2. CI、双 Registry 发布、manifest、迁移和 OTA 的发布门禁。
3. MCP 与 API 的真实认证/路由契约。
4. 版本、文档、公开仓库和可恢复性治理。

建议将下一主版本目标定义为“production hardening”，而不是继续扩大功能清单。

## 3. 能力成熟度

| 领域 | 当前状态 | 主要缺口 |
| --- | --- | --- |
| Admin / API | 已有完整业务骨架和大量真实功能 | 权限边界、错误契约和生产验证需要统一 |
| Tables / SQL / Hasura | 可管理 schema、数据和 metadata | 默认 permissions 过宽，匿名写入风险高 |
| Project Auth | 微信、OIDC 和项目 session 主链已开始落地 | GraphQL、Realtime、Storage 尚未统一消费同一身份 |
| Storage | Local、R2、内部 helper、trusted ticket 已有实现 | 终端用户权限和对象策略仍需统一验证 |
| Realtime | 可配置表级开关并建立订阅 | SDK 建连身份传播不完整 |
| Functions | Deno Worker、invoke auth mode、内部 GraphQL/Storage helper 已有实现 | 历史函数和匿名调用策略仍需收敛 |
| SDK | auth/database/storage/realtime/rpc/functions 已有基础能力 | 兼容结论应继续由真实迁移验证 |
| MCP | Server 和工具入口已经存在 | API key 请求头与 API 路由身份契约存在不一致 |
| 发布 | GitHub Release、GHCR、自建 Registry 双推送已实现 | 缺少稳定质量门禁和发布前验证矩阵 |
| OTA | 检查、下载、apply、健康检查、回滚、updater finalizer 已实现 | 生产路径配置、迁移边界和数据库恢复尚未完整演练 |

## 4. 应用与权限评估

### 4.1 已实现基础

- 平台租户/项目、环境、API Key 和设置管理。
- Schema、Tables、数据 CRUD、SQL、CSV、ER 图和 Hasura metadata 同步。
- Storage bucket/object 管理，Local/R2 adapter，内部 Functions helper 和 trusted ticket。
- 平台用户与项目终端用户认证分层的第一阶段实现。
- Realtime 表级开关、Edge Functions、RPC、SDK 和结构化日志。

这些能力说明 Druvia 已具备可用产品骨架，但“功能存在”不等于默认权限已经适合公网生产。

### 4.2 最高优先级风险：Hasura 默认权限

当前表同步代码会生成范围过宽的 `user` CRUD permissions，并存在匿名 insert/update/delete 路径。若没有明确行过滤和列限制，这会把项目 API key 变成高权限写入凭证。

后续应：

1. 将默认权限改为拒绝或最小只读。
2. 将角色、行过滤、列级权限和操作类型显式建模。
3. 只允许经过业务评审的匿名写入。
4. 为权限生成、同步和升级后的 metadata 增加集成测试。

相关实现入口：

- `apps/api/src/modules/table/table.service.ts`
- `apps/api/src/modules/realtime/realtime.service.ts`
- `hasura/metadata`

### 4.3 项目身份尚未全链路统一

项目 session 已用于部分 Functions 和 RPC，但以下路径仍需统一：

- GraphQL：确认 project-user claim、Hasura role 和行级过滤完整传播。
- Realtime：SDK 当前建连初始化信息不足，不能仅凭连接成功认定用户级授权完成。
- Storage：平台用户、project-user、trusted ticket 和内部函数调用应有明确且互斥的授权规则。
- Functions：历史匿名函数需要逐个收敛为 `jwt_required` 或经审查的 `anon_allowed`。

建议建立统一的 `actor` 契约，至少包含 actor type、project id、project user id、role 和可信来源，并在 HTTP、WebSocket、Worker 和审计日志间保持一致。

## 5. SDK 与迁移兼容评估

SDK 已补齐一批 Supabase 风格能力，包括查询修饰符、session 刷新、用户更新、channel 管理、project auth 和 trusted storage helper。后续重点不应是继续追求 API 名称覆盖率，而是按真实 taro-app 迁移链验证：

1. 登录前匿名调用。
2. 登录后 project session 恢复与刷新。
3. GraphQL/RPC/Functions 的 token 选择顺序。
4. Realtime 断线重连后的身份恢复。
5. Storage 上传、替换、删除和审计。

兼容声明应分为“接口兼容”“行为兼容”“迁移验证通过”，避免使用笼统的“兼容 Supabase”。

## 6. MCP 评估

MCP Server 已具备工具入口和日志基础，但当前不应标记为生产就绪：

- MCP 使用的 API key 请求头与 API 中间件实际读取的头名存在不一致。
- 部分 schema 管理路由仍要求 platform user，不能直接由项目 API key 完成。
- 缺少覆盖真实 API 的契约测试。

建议先定义 MCP 的目标身份：

- 管理型 MCP：使用平台用户或专用管理凭证，只允许受控管理操作。
- 项目型 MCP：使用 project-scoped key，只允许项目数据和明确开放能力。

完成身份模型后，再统一头部、路由、scope、错误码和审计日志。

相关入口：

- `packages/mcp-server/src/index.ts`
- `apps/api/src/middleware/auth.ts`

## 7. 发布与镜像分发评估

### 7.1 当前发布模型

GitHub Actions 会构建 `api/admin/worker/updater` 四类镜像，同时推送：

- GHCR
- 自建 Registry `druvia.forestpartner.com`

随后生成两个 manifest：

- `release-manifest.json`: GHCR 镜像 digest
- `release-manifest.cn.json`: 自建 Registry 镜像 digest

部署端通过 `.env.release` 的 manifest URL 和初始镜像前缀选择更新源。两份 manifest 是两条完整发布路径，不应在一次更新中交叉使用镜像 digest。

### 7.2 当前发布风险

- release workflow 在镜像构建前缺少稳定的 lint、typecheck、unit/integration test 门禁。
- 当前构建没有明确 multi-architecture matrix；Apple Silicon 本地测试会出现 amd64 模拟警告。
- migration 范围依赖手工输入，容易与仓库真实迁移不一致。
- 双 Registry 当前在同一 job 中强耦合，自建 Registry 慢或不可用会影响整个发布。
- example 中的 GitHub owner/repository 必须与实际公开仓库一致，不能保留占位路径。
- 根 package、SDK prerelease 和产品 release tag 存在不同版本轴，需要明确各自语义。

### 7.3 建议发布门禁

1. 代码质量 job：安装锁定依赖、typecheck/build、lint、核心单元测试。
2. 镜像 job：按目标架构构建并执行容器健康检查。
3. 发布元数据 job：自动计算 migration from/to，校验 manifest schema 和所有 digest。
4. 分发 job：GHCR 与自建 Registry 独立重试和报告；只有满足发布策略时才创建 Release。
5. OTA smoke job：从上一个稳定版本在临时 Compose 环境升级到候选版本。

## 8. OTA 更新评估

### 8.1 已形成的闭环

- Admin 被动通知、检查更新、下载、重启应用和阶段进度反馈。
- API 使用 `platform_user + super_admin` 代理更新操作。
- Updater 独占 Docker socket，执行 manifest 校验、digest 拉取、状态落盘和 Compose 操作。
- apply 后通过一次性 finalizer 替换 updater 自身并写回最终状态。
- 支持 GHCR 和自建 Registry 两条更新源。
- 支持本地 `with-local-nginx` OTA 演练和生产 nginx/外部反代模式。

### 8.2 已暴露的生产问题

生产从传统部署切换到 release-mode 时已经暴露几类环境特定问题：

- manifest URL 指向错误 owner 或选择了不存在的 `release-manifest.cn.json` 会在检查阶段返回 404。
- 把开发机 `.env.release` 直接复制到生产，会保留 `/Users/...` 绝对路径。Updater 在备份 `.env.release` 时会按该路径执行并触发 `ENOENT`。
- Registry 的 manifest 请求可正常返回，但大 layer 下载可能极慢，说明 Registry 主机出口、反代 buffering/timeouts、磁盘吞吐或跨地域链路仍需独立观测。
- `up -d` 后 nginx 可能短时间连接 API 被拒绝，发布流程应以健康检查为准，而不是以容器进入 running 为准。

生产初始化必须在目标主机重新生成：

- `DRUVIA_DEPLOY_DIR`
- `DRUVIA_BASE_ENV_FILE`
- `DRUVIA_RELEASE_ENV_FILE`
- `DRUVIA_COMPOSE_FILE`
- `DRUVIA_COMPOSE_PROFILES`
- 初始镜像前缀和 manifest URL

建议路径覆盖项默认留空，由目标主机的 `DRUVIA_DEPLOY_DIR` 推导，减少跨机器复制错误。

### 8.3 尚未闭环的恢复能力

- Updater 会在需要时执行 `pg_dump`，但数据库恢复仍是人工流程。
- manifest 的 migration from/to 与实际数据库迁移状态需要强校验。
- 应验证 dump 可被 `pg_restore --list` 或对应恢复工具读取，不能只检查文件存在。
- 需要正式演练：镜像下载失败、迁移失败、健康检查失败、updater finalizer 失败、Registry 中断和数据库人工恢复。
- Docker socket 使 updater 等价于宿主机高权限组件，必须限制网络入口、secret 和镜像来源。

## 9. 文档和公开仓库治理

Codex 官方只自动发现 `AGENTS.md` 层级，不会自动读取任意命名的项目 memory 文件。仓库因此采用：

- 根/局部 `AGENTS.md`: 执行约束
- `docs/agent/design-decisions.md`: 长期决策
- `docs/agent/playbooks.md`: 操作流程
- `docs/progress.md`: 当前阶段
- 日期化 `docs/plans/*`: 完整背景、评估和实施记录

参考：[OpenAI Codex AGENTS.md 官方文档](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

公开仓库还应补齐或持续检查：

- `README.md` 的安装、架构、开发和 release-mode 说明
- 明确的开源 `LICENSE`
- `.env*`、证书、Registry auth、数据库、Redis、Storage、日志和备份数据的 Git ignore
- 文档中的真实域名、用户名、绝对路径和历史凭证
- Git 历史中已经提交过的 secret；仅添加 ignore 不能撤销历史泄露

## 10. 建议路线

### Phase A：0.4.0 生产安全基线

- 收紧 Hasura permissions 和匿名写入。
- 定义统一 project actor 契约并打通 GraphQL/Realtime/Storage/Functions。
- 修正 MCP 认证/路由契约，或暂时明确标记实验性。
- 清理 lint 和核心单测失败，建立 release 必过门禁。
- 修正文档、版本轴、README、LICENSE 和公开仓库敏感信息治理。

### Phase B：0.4.x 发布可靠性

- 自动生成和校验 migration metadata。
- 增加 multi-architecture 镜像或明确只支持 amd64。
- 将 GHCR、自建 Registry 推送和失败策略解耦。
- 增加从上一稳定版升级的自动 smoke test。
- 完成 OTA 故障矩阵和数据库恢复演练。

### Phase C：0.5.x 迁移产品化

- 用真实 taro-app 场景完成 SDK/Auth/Storage/Realtime 验收。
- 建立 Supabase compatibility matrix。
- 将迁移脚本、检查器或 CLI 产品化。
- 在权限和发布基线稳定后再增加更多国内 Auth/Storage adapter。

### Phase D：后续商业化

- 企业级多租户隔离、审计、备份恢复、SLA 和升级策略。
- Provider 插件化、商业授权和受支持部署矩阵。
- 在真实运维数据基础上决定是否引入 Harbor 等更重的 Registry 管理组件。

## 11. 验证快照

本次代码层评估使用的本地验证快照：

- monorepo build：6 个 workspace 构建通过。
- 聚焦 API/SDK/unit 测试：411 个通过，1 个失败；失败为 update contract 对 `finalizing` 阶段预期未同步。
- lint：17 errors、12 warnings，说明当前不适合作为 release 绿灯。
- 全量测试：31 failed、71 passed、348 skipped；多数失败来自本地 PostgreSQL `5532` 和 Redis `6479` 未运行，不能全部归类为产品缺陷，但也说明测试环境前置条件尚未标准化。

后续判断“可发布”时，应重新运行当前提交上的完整命令并保存输出，不能长期引用本快照代替最新证据。

## 12. 验收标准

达到下一阶段生产基线至少应满足：

- 默认项目不能通过匿名 API key 获得无过滤写权限。
- 同一个 project-user 在 GraphQL、Realtime、Storage、RPC 和 Functions 中具有一致身份和审计信息。
- MCP 的每个工具都有与真实 API 对接的契约测试。
- release workflow 在质量门禁失败时不会推送稳定发布。
- GHCR 和自建 Registry 均能从上一稳定版本完成 OTA。
- 故障更新能恢复旧镜像，数据库 dump 已验证可恢复，人工恢复 playbook 可执行。
- 新部署不依赖源码目录，环境文件不包含其他主机绝对路径。

