# Druvia 平台日志使用指南

## 概览

Druvia 的平台日志分两层：

- Phase 1：各自研服务输出结构化 JSON 到 `stdout/stderr`
- Phase 2：官方提供可选的 `Loki + Promtail + Grafana` 部署示例

Phase 2 是可选能力，不是 Druvia 最小运行依赖。不启用 `with-logs` profile 时，平台仍可正常运行。

## 覆盖范围

当前 `with-logs` profile 会采集以下官方 compose 服务的容器日志：

- `druvia-api`
- `druvia-admin`
- `druvia-deno`
- `druvia-hasura`
- `druvia-postgres`
- `druvia-redis`
- `druvia-nginx`

Promtail 只抓取上述 Druvia 官方容器，不会默认抓取宿主机上所有 Docker 容器。

## 启动方式

### 本地 local compose

仅启用日志栈：

```bash
cd docker
docker compose -f docker-compose.local.yml --profile with-logs up -d
```

与 Nginx 一起启用：

```bash
cd docker
docker compose -f docker-compose.local.yml --profile with-nginx --profile with-logs up -d
```

### 生产 prod compose

```bash
cd docker
docker compose -f docker-compose.prod.yml --profile with-logs up -d
```

如果生产环境也启用了 Nginx：

```bash
cd docker
docker compose -f docker-compose.prod.yml --profile with-nginx --profile with-logs up -d
```

## 默认端口与凭证

可通过 `docker/.env` 或生产环境对应 `.env` 覆盖：

- `LOKI_PORT=3100`
- `GRAFANA_PORT=3002`
- `GRAFANA_ADMIN_USER=admin`
- `GRAFANA_ADMIN_PASSWORD=admin`

Grafana 默认访问地址：

```text
http://localhost:3002
```

当前日志栈的持久化目录会落在：

- `docker/loki_data`
- `docker/promtail_data`
- `docker/grafana_data`

这些目录已加入仓库忽略规则。

## Loki 标签约定

Promtail 当前会为日志添加以下核心标签：

- `job="druvia"`
- `service`
- `container`

其中：

- `service` 取自容器名去掉 `druvia-` 前缀后的值，如 `api`、`admin`、`deno`
- `container` 保留完整容器名，如 `druvia-api`

## 常用查询示例

查看所有 Druvia 日志：

```logql
{job="druvia"}
```

只看 API 日志：

```logql
{job="druvia", service="api"}
```

只看 Deno Worker 错误日志：

```logql
{job="druvia", service="deno"} |= "\"level\":\"error\""
```

筛选某个函数执行日志：

```logql
{job="druvia", service="deno"} |= "\"functionName\":\"wx-login-register\""
```

筛选某个项目日志：

```logql
{job="druvia"} |= "\"projectId\":\"proj_xxx\""
```

## 验证建议

启动后可先验证三件事：

1. 打开 Grafana，确认内置 `Loki` datasource 已自动存在
2. 在 Explore 中执行 `{job="druvia"}`，确认能看到容器日志
3. 分别触发一次 API 请求、一次函数调用，确认能看到：
   - API 的 request log
   - Deno Worker 的 `function execution started/succeeded/failed`

## 运行边界

- 该日志栈只是官方推荐示例，不限制你改用 Datadog、ELK、云日志或其他方案
- 为避免 bind mount 目录的首次写入权限问题，`loki/promtail/grafana` 当前以容器内 root 用户运行
- 如果 Promtail 因宿主机 Docker 日志路径限制无法工作，仍可先使用 `docker logs` 直接查看 Phase 1 输出
- MCP Server 当前不在官方 compose 中，因此不在这套 Phase 2 采集范围内
