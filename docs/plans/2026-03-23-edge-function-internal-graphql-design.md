# Edge Function Internal GraphQL Proxy 设计

## 背景

当前 taro-app 迁移联调中，`wx-login-register` 这类 Edge Function 已经能够工作，但实现路径仍依赖项目函数直接持有并使用 Hasura admin 通道相关信息，例如：

- `DRUVIA_GRAPHQL_URL`
- `HASURA_ADMIN_SECRET`
- 或等价的 `DRUVIA_SERVICE_ROLE_KEY`

这类方案可以作为当前本地联调的临时兼容路径，但不应成为 Druvia 的正式平台能力。原因在于：

- 项目级 Edge Function 不应持有跨项目的底层数据库管理入口
- 平台级 secret 不应作为项目级 secrets 暴露给函数运行时
- 当前方案与 Druvia 的项目隔离模型冲突

因此需要设计一条正式的、受控的函数内部 GraphQL 调用链路，替代项目函数直连 Hasura admin 的过渡方案。

## 目标

Phase 1 的目标是为 Druvia Edge Function 建立正式的内部受控 GraphQL 调用能力，优先做通用能力，`wx-login-register` 作为首个落地场景。

具体目标：

- 新增专用内部路由：`POST /api/internal/functions/graphql`
- 平台在函数 invoke 时签发短时 internal token
- token 只代表“当前项目的本次函数执行身份”
- token 不暴露给用户，不出现在 Admin secrets UI
- 平台在函数运行时内建 `druvia` helper，Phase 1 只实现：
  - `druvia.graphql(query, variables?)`
- `wx-login-register` 从“函数直连 Hasura admin”迁移到“函数走平台 internal GraphQL proxy”

## 非目标

本次不做以下内容：

- 不在 Phase 1 引入 `druvia.rpc()` 或 `druvia.storage()`
- 不把 internal token 设计成用户可见、可配置的 secret
- 不要求旧函数自动兼容新模型
- 不把用户级细粒度权限一起纳入 Phase 1

后续是否扩展 `druvia.rpc()`、`druvia.storage()`，根据外部应用迁移到 Druvia 的实际案例按需推进，不预先承诺固定阶段。

## 设计原则

### 1. 平台级 secret 永远只留在平台服务端

`HASURA_ADMIN_SECRET` 及其等价能力不得继续作为项目级函数 secrets 的正式输入。

### 2. 项目边界由平台恢复，不由函数声明

函数内部 GraphQL 调用不暴露 `projectId` 参数，平台只从 internal token 恢复并绑定当前项目。

### 3. 新函数默认直接可用，旧函数按规范改造

Phase 1 优先让新模型清晰可用，不为兼容旧写法牺牲边界。

### 4. 真实迁移案例驱动后续扩展

GraphQL 先行，后续内部 RPC / Storage 是否实现由真实外部应用迁移需求驱动。

## 目标架构

```
前端 / 小程序
  -> functions.invoke()

Druvia API
  -> 在 invoke 前签发短时 internal token
  -> 将 token 作为执行期内部凭证注入函数运行时

Edge Function 运行时
  -> 内建 druvia.graphql(query, variables?)
  -> helper 自动带 token 调用 /api/internal/functions/graphql

Druvia API Internal Route
  -> 校验 token
  -> 恢复 projectId / functionName / authType
  -> 自动绑定当前项目
  -> 服务端持有 HASURA_ADMIN_SECRET 访问 Hasura

Hasura
  -> admin secret 永远只保留在平台服务端
```

## Internal Token 模型

### 定位

internal token 是平台执行期内部凭证，不是用户 token，也不是项目配置项。

它的职责是表达：

- 当前项目
- 当前函数
- 当前调用类型
- 有效期

### 最小载荷

- `projectId`
- `functionName`
- `authType`
- `exp`

### 生命周期

- 由 Druvia API 在函数 invoke 前签发
- 仅用于本次函数执行期间访问 internal route
- 不暴露给用户侧
- 不要求用户管理过期、刷新、续期
- 过期后本次函数执行失败；如需重试，应重新发起函数调用并获取新的执行期 token

## Helper 设计

### 对外形态

Phase 1 在函数运行时提供内建 `druvia` 容器，当前只实现：

```ts
const result = await druvia.graphql(query, variables)
```

### 可用范围

- 新函数：默认直接可用
- 旧函数：按迁移规范改造

### 返回语义

`druvia.graphql()` 保持接近原始 GraphQL 响应：

```ts
{
  data: ...,
  errors: ...
}
```

设计取舍：

- 保持底层错误较透明
- 不额外包装统一平台错误对象
- 优先利于迁移与联调排错

## Internal Route 约束

### 路由

- `POST /api/internal/functions/graphql`

### 认证

- 仅接受 internal token
- 不接受前端 `apikey`
- 不接受前端 JWT

### 授权

- 不信任请求体中任何项目标识
- 只以 internal token 恢复出的 `projectId` 为准
- 自动绑定当前项目范围

### 权限语义

Phase 1 是项目级内部身份，而不是用户级身份。

这意味着：

- 适合登录前函数和项目级后台逻辑
- 不适合表达用户态细粒度权限

### 能力范围

Phase 1 允许项目内完整 GraphQL 读写。

原因：

- 先以最小正式能力替换当前高风险的直连 Hasura admin 方案
- 降低 `wx-login-register` 首个迁移场景的改造成本

## 新旧方案分层

### 临时兼容方案

当前项目函数直接访问 Hasura admin 通道的做法：

- 仅作为现阶段联调用的临时兼容路径
- 不应写入正式推荐文档

### 正式方案

项目函数内部调用 GraphQL 的正式方案应为：

- 函数调用 `druvia.graphql()`
- 平台内部使用 internal token
- API internal route 代理 Hasura
- 平台 secret 永远不下发到项目函数运行时

## 首个落地场景

`wx-login-register` 作为 Phase 1 首个落地场景，目标是：

- 不再依赖项目 secrets 中的 Hasura admin 类 secret
- 改为使用 `druvia.graphql()`
- 保持当前登录链路可用

## 成功标准

- `wx-login-register` 不再依赖项目级 Hasura admin 类 secret
- 项目函数内部 GraphQL 调用不能跨项目
- 新函数无需额外 secrets 配置即可使用 `druvia.graphql()`
- 平台级 secret 仅保留在 API 服务端
- 旧函数可按规范逐步迁移，新函数默认采用正式模型

## 后续扩展

后续是否扩展以下能力，由真实迁移需求决定：

- `druvia.rpc()`
- `druvia.storage()`

原则是：

- 不提前承诺固定阶段
- 不为了平台完整性先做过度抽象
- 继续以外部应用迁移到 Druvia 的实际案例牵引
