# Druvia 平台日志能力设计

## 背景

当前 Druvia 已具备基础日志输出能力，但整体状态仍然分散：

- `apps/api` 已启用 Fastify 自带 logger，日志主要输出到 stdout
- `docker/deno-worker`、`packages/mcp-server`、部分 API 模块、Admin 服务端仍大量使用 `console.log/warn/error`
- 不同服务的日志格式、字段、错误输出方式不统一
- 现有 Docker Compose 不包含集中日志栈，用户只能依赖 `docker logs` 或自行接入第三方方案

这在真实联调和生产排障中会带来几个问题：

1. 跨服务排障成本高，难以按 `projectId`、`requestId`、`functionName` 等维度检索
2. 自研服务日志与基础设施日志缺少统一接入边界
3. 当前日志能力无法作为稳定的“可观测性基础”，也不利于后续接入 Loki、Datadog、云日志等系统

## 目标

建立 Druvia 的统一日志基础能力，并明确平台边界：

1. Druvia 自研服务默认输出统一结构化日志到 `stdout/stderr`
2. 日志输出可被任意外部日志系统直接采集
3. 平台不强绑定唯一日志后端
4. 官方提供一套推荐日志部署参考方案，但不作为默认依赖
5. 保持当前最小部署路径轻量，不因日志能力显著抬高默认运行成本

## 非目标

本阶段不包含：

- 浏览器前端日志采集与上报
- 数据库日志落表或平台内建日志中心
- 强绑定 ELK / OpenSearch / Datadog / 云厂商日志服务
- 全链路 tracing / metrics / logs 一体化方案
- Admin UI 内置日志查询页面

## 方案比较

### 方案 A：平台只负责结构化 stdout

描述：

- Druvia 统一各服务日志格式
- 只保证日志输出正确、结构化、可采集
- 日志采集和展示完全由用户自定义

优点：

- 影响面最小
- 对部署和资源要求最低
- 最符合自托管平台边界

缺点：

- 官方开箱排障体验一般
- 用户需要自己设计接入方案

### 方案 B：结构化 stdout + 官方推荐可选日志栈

描述：

- 平台先统一 stdout 结构化日志
- 官方再提供 `Loki + Promtail + Grafana` 的可选部署参考
- 默认部署不依赖日志栈

优点：

- 平台边界清晰
- 兼顾轻量默认部署与官方推荐路径
- 有利于后续形成统一文档和示例

缺点：

- 需要额外维护可选 compose profile 和基础文档

### 方案 C：平台直接内置强绑定日志后端

描述：

- Druvia 默认部署即自带统一日志采集与检索栈

优点：

- 开箱体验最好

缺点：

- 部署和运维负担显著增加
- 不符合当前 Druvia 的轻量自托管定位
- 会强迫所有用户接受相同的日志技术栈

## 方案选型

采用方案 B：

- Phase 1：应用层统一结构化 stdout/stderr
- Phase 2：提供 `Loki + Promtail + Grafana` 推荐组合的可选部署

不采用方案 C 的原因：

1. 当前 Druvia 产品阶段更强调“可自托管、可轻量部署”
2. 日志后端属于运维体系，不适合作为平台最小运行前提
3. 用户侧可能已有现成日志方案，平台不应强绑唯一栈

## 覆盖范围

### 自研服务范围

Phase 1 统一结构化日志的目标服务：

- `apps/api`
- `apps/admin` 的服务端执行部分
- `packages/mcp-server`
- `docker/deno-worker`

### 基础设施范围

平台推荐采集范围还应包含：

- `hasura`
- `postgres`
- `redis`
- `nginx`

说明：

- 基础设施日志在 Phase 1 不要求修改内部输出格式
- 只要求其容器 stdout/stderr 可被统一采集

## 日志边界与职责

### Druvia 平台负责

1. 自研服务输出统一结构化日志
2. 统一字段规范、级别规范、错误序列化规范
3. 提供可选推荐日志部署示例
4. 保证日志默认可被容器环境直接采集

### 用户或运维侧负责

1. 选择实际日志后端
2. 决定保留周期、告警策略、归档策略
3. 决定是否使用官方推荐日志栈
4. 将 Druvia 日志接入其现有运维体系

## 日志输出模型

### 输出方式

所有自研服务默认输出到：

- `stdout`
- `stderr`

不在 Phase 1 内默认增加：

- 本地日志文件
- PostgreSQL 日志表
- 外部 SaaS 直传

### 输出格式

统一使用 JSON line 日志。

示例：

```json
{
  "ts": "2026-03-27T10:00:00.000Z",
  "level": "info",
  "service": "api",
  "module": "project-auth",
  "msg": "project user created",
  "env": "production",
  "requestId": "req-123",
  "tenantId": "default",
  "projectId": "proj_xxx",
  "projectUserId": "550e8400-e29b-41d4-a716-446655440000",
  "durationMs": 24
}
```

错误日志示例：

```json
{
  "ts": "2026-03-27T10:00:02.000Z",
  "level": "error",
  "service": "deno-worker",
  "module": "executor",
  "msg": "function execution failed",
  "projectId": "proj_xxx",
  "functionName": "wx-login-register",
  "executionId": "exec_xxx",
  "err": {
    "name": "ProjectAuthError",
    "code": "USER_CREATE_FAILED",
    "message": "Failed to create project user"
  }
}
```

## 契约复用边界

Phase 1 统一的是“日志契约”，不要求所有运行时强行共用同一个实现模块。

原因：

- API、Admin 服务端、MCP Server 运行在 Node.js 环境
- Deno Worker 运行在独立 Deno 容器中，当前不直接消费 monorepo 的 `packages/shared` 构建产物

因此 Phase 1 的正式边界是：

- 字段命名
- 错误序列化语义
- level 语义
- 上下文字段约定

这些在设计与文档层统一；

具体实现上允许：

- Node 侧共享一套 helper
- Deno 侧独立实现同构输出

不要求在 Phase 1 先打通 Node/Deno 共用同一源码模块。

## 字段规范

### 必填基础字段

- `ts`
- `level`
- `service`
- `msg`

### 推荐上下文字段

- `module`
- `env`
- `requestId`
- `tenantId`
- `projectId`
- `userId`
- `projectUserId`
- `functionName`
- `executionId`
- `durationMs`

### 错误字段

- `err.name`
- `err.code`
- `err.message`
- `err.stack`

说明：

- `stack` 可在生产环境保留，但应作为错误日志字段而不是普通信息字段
- 不要求每条日志都带齐所有业务上下文
- 但相同服务内应遵循一致命名，避免同义字段混乱

## 日志级别策略

统一采用：

- `debug`
- `info`
- `warn`
- `error`

建议默认值：

- 开发环境：`debug` 或 `info`
- 生产环境：`info`

要求：

- 高频成功路径默认只记录摘要
- `debug` 不应长期在生产环境全局开启
- 错误日志必须包含稳定错误语义，而不是只有字符串

## 敏感信息与脱敏策略

默认不记录以下内容的原文：

- Authorization token
- API key
- Refresh token
- Hasura admin secret
- 用户密码
- 完整文件内容
- 完整 SQL 结果集

对请求体、响应体、headers 的记录原则：

- 默认不全量记录
- 仅在极少数明确白名单场景下记录必要摘要
- 若需要排障级扩展日志，应经过显式配置开关控制

## 各服务设计要点

### API

- 以 Fastify logger 为主入口
- 统一 request / response / error 的结构化字段
- 收口关键业务模块中的 `console.*`
- 支持 child logger 或 module-scoped logger
- 需要显式定义上下文注入方式：
  - `requestId`
  - `tenantId`
  - `projectId`
  - `userId` / `projectUserId`

### Deno Worker

- 函数执行开始、结束、失败都输出结构化日志
- 带上：
  - `projectId`
  - `functionName`
  - `executionId`
- 不把业务 payload 全量打到日志中
- 上下文来源由平台执行上下文决定，而不是由函数作者自行传入

### MCP Server

- 启动、鉴权失败、上游请求失败统一结构化输出
- 统一 `service = "mcp-server"`
- Phase 1 只要求 MCP 进程本身输出结构化 stdout
- 只有当 MCP 被纳入官方 compose 部署后，Phase 2 才要求推荐日志栈覆盖其容器采集

### Admin

- 仅覆盖服务端执行路径
- 浏览器端 `console.*` 不纳入本阶段平台日志规范

## 部署与集成模型

### 默认模型

- Druvia 只输出结构化 stdout/stderr
- 用户自行选择日志采集与展示方案

兼容目标包括但不限于：

- `Loki + Promtail + Grafana`
- `Vector`
- `Fluent Bit`
- `Datadog`
- `ELK / OpenSearch`
- 云厂商日志服务

### 官方推荐模型

官方推荐组合：

- `Loki`
- `Promtail`
- `Grafana`

原因：

- 与 Docker Compose / 单机自托管模式更匹配
- 相比 ELK 资源更轻
- 适合作为 Druvia 官方参考方案

但该方案必须是：

- 可选部署
- 非默认依赖

## 性能影响评估

### Phase 1：结构化 stdout

影响级别：

- 低到中等

主要开销：

- JSON 序列化
- stdout/stderr I/O

可控前提：

- 不记录大对象
- 不默认全量记录 body / result
- 高频接口不滥用 `debug`

### Phase 2：集中日志栈

影响级别：

- 中等

新增成本：

- 采集 agent 资源开销
- Loki 存储与查询开销
- Grafana 面板与告警管理成本

因此必须保持可选部署，而不是最小运行前提。

## 对现有架构的影响评估

### 低风险部分

- 不改对外 API 协议
- 不改 SDK 使用方式
- 不改数据库模型
- 不影响 taro-app 等外部迁移项目的接口兼容

### 中等影响部分

- API、Deno Worker、MCP Server 代码需要收口日志调用方式
- 需要增加统一 logger 工具与日志字段规范
- 文档与运维说明需要同步更新

### 高风险部分

当前方案避免引入高风险项：

- 不默认引入重型日志后端
- 不默认把日志写入数据库
- 不在 Phase 1 同步引入 tracing 体系

## 分阶段路线

### Phase 1：统一结构化 stdout

交付物：

- 统一日志规范
- 统一 logger 工具
- API / Deno / MCP / Admin 服务端关键日志统一
- 文档说明与运维接入指引

### Phase 2：官方推荐日志栈

交付物：

- 可选 compose profile
- `Loki + Promtail + Grafana` 部署示例
- 基础 dashboard / 查询示例
- 覆盖当前官方 compose 中的服务容器
- 若后续 MCP 被加入官方 compose，再扩展其采集覆盖

### Phase 3：更强可观测性

后续再评估：

- tracing
- metrics
- 日志查询 UI
- 告警模板

## 结论

Druvia 的整体日志能力应采用：

- 默认提供统一结构化 stdout/stderr
- 不强绑定日志后端
- 官方提供 `Loki + Promtail + Grafana` 作为推荐可选部署

这条路线最符合当前 Druvia 的自托管边界、部署轻量性和真实项目迁移阶段需求。
