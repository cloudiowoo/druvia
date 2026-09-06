# RPC 数据库业务拒绝映射

## 1. 状态

- 日期：2026-09-05
- 状态：本地实现完成，待 PITCHETCH 应用侧重跑 RPC 验收矩阵
- 范围：Druvia API RPC 错误契约、SDK 契约测试和文档
- 非范围：数据库 migration、Hasura metadata、PITCHETCH schema 与业务函数修改、生产发布

## 2. 问题与证据

PITCHETCH 的 `pitchetch_complete_base_samples` 会在 upload chunks、manifest 或 observation
不完整时执行 PostgreSQL `RAISE EXCEPTION`。本地 PostGIS 函数定义确认这些预期拒绝使用
默认 SQLSTATE `P0001`。

修改前 `rpc.service` 在 rollback 后原样抛出数据库错误，而 controller 只识别 `RpcError`，
因此 `P0001` 被映射为 HTTP 500 `RPC_ERROR`。客户端会把 500 解释为可重试服务故障，无法
将数据不完整识别为确定性业务拒绝。

## 3. 最终契约

业务函数实际调用阶段抛出 `P0001`，且 rollback 成功时返回：

```json
{
  "data": null,
  "error": {
    "code": "RPC_REJECTED",
    "message": "RPC request rejected"
  }
}
```

HTTP 状态为 400。客户端不得收到 PostgreSQL 原始 `message`、`detail`、`hint` 或 SQL。

以下错误不进入该映射：

- 函数发现失败以外的数据库查询错误；
- 数据库连接错误；
- `BEGIN`、actor context `set_config` 或 `COMMIT` 错误；
- `ROLLBACK` 错误；
- `P0001` 以外的 SQLSTATE。

`FUNCTION_NOT_FOUND` 继续返回 404；其他未知错误继续返回 HTTP 500 `RPC_ERROR`。如果函数
先抛出 `P0001`、随后 rollback 失败，则以 rollback 基础设施故障返回 500，并丢弃连接。

## 4. 实施

- [x] service 记录 `setup / invoke / commit` 阶段，只转换 invoke 阶段的 `P0001`。
- [x] service 在转换前完成 rollback；rollback 失败时保留 500 路径。
- [x] controller 返回固定 HTTP 400 `RPC_REJECTED` 响应。
- [x] 预期业务拒绝记录 `warn`，不记录数据库原始错误；未知错误继续记录 `error`。
- [x] SDK 保持现有非 2xx `json.error` 读取逻辑，并增加 400 契约测试。
- [ ] PITCHETCH 重跑 seal、time-only、跨用户 RPC、delete/tombstone 和 spatial 矩阵。

## 5. 验收标准

1. `pitchetch_complete_base_samples` 的不完整数据拒绝返回 HTTP 400 `RPC_REJECTED`。
2. 响应不包含 `PITCHETCH upload chunks are incomplete` 等数据库原始消息。
3. 未知 SQLSTATE 和连接错误继续返回 HTTP 500 `RPC_ERROR`。
4. actor context 设置阶段的 `P0001` 不会误映射为业务拒绝。
5. `P0001` 后 rollback 失败时返回 500，异常连接被丢弃。
6. 既有函数成功、函数不存在、跨项目和 actor claims 行为不变。

## 6. 验证证据

- RPC service/controller 与 SDK 定向回归 28/28 通过；依赖真实服务的 Project Actor
  integration 3 项按环境开关跳过。
- 全量 unit 与 RPC SDK 回归 928/928 通过。
- API 与 SDK TypeScript 构建通过，`git diff --check` 通过。
- 本地 PostGIS 在 PITCHETCH schema 临时创建真实 `RAISE EXCEPTION` 探针，通过编译后的
  controller 调用得到 HTTP 400、`RPC_REJECTED` 和固定文案；warn 日志只包含 actor 与函数
  审计上下文，不包含探针的数据库原始消息。探针已删除，残留计数为 0。
- 独立高风险 review 未发现 Critical、High 或 Medium finding。
