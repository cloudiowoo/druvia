# Druvia vs Supabase 自托管架构对比

> 文档编号: 001
> 创建日期: 2026-02-27
> 版本: 1.0

## 1. 架构组件对比

| 功能 | Supabase 自托管 | Druvia | 说明 |
|------|-----------------|--------|------|
| 数据库 | PostgreSQL | PostgreSQL 17 | 相同 |
| REST API | PostgREST | Hasura (内置) | Hasura 原生支持 |
| GraphQL | 无原生支持 | Hasura (原生) | Druvia 优势 |
| Realtime | Elixir Server | Hasura Subscriptions | 架构更简单 |
| API Gateway | Kong (~2.5GB) | 无需 | 显著节省资源 |
| Auth | GoTrue | Node.js 适配器 | 集成在 API 中 |
| Storage | Storage API + imgproxy | Node.js 适配器 (R2/S3/Local) | 集成在 API 中 |
| Edge Functions | Deno Runtime | 待实现 | - |
| 连接池 | Supavisor | 待实现 (PgBouncer) | - |
| 日志 | Vector + Logflare | 可选 | - |
| 管理界面 | Studio | Next.js Admin | 自研 |

---

## 2. 内存占用对比 (单租户单项目)

### 2.1 Supabase 自托管

| 服务 | 内存 |
|------|------|
| Kong (API Gateway) | ~2,500 MB |
| Analytics/Logflare | ~525 MB |
| PostgreSQL | ~350 MB |
| Realtime (Elixir) | ~211 MB |
| Storage API | ~100 MB |
| Edge Runtime (Deno) | ~150 MB |
| PostgREST | ~116 MB |
| GoTrue (Auth) | ~9 MB |
| 其他服务 | ~200 MB |
| **总计** | **~4,200 MB** |

### 2.2 Druvia (当前)

| 服务 | 内存 |
|------|------|
| PostgreSQL 17 | ~350 MB |
| Hasura 2.48 | ~500 MB |
| Redis 7 | ~50 MB |
| Node.js API (Fastify) | ~150 MB |
| **总计** | **~1,050 MB** |

### 2.3 Druvia (完整功能)

| 服务 | 内存 | 说明 |
|------|------|------|
| PostgreSQL 17 | ~350 MB | |
| Hasura 2.48 | ~800 MB | 含 Subscriptions 负载 |
| Redis 7 | ~100 MB | 缓存 + 会话 |
| Node.js API | ~200 MB | Auth + Storage 逻辑 |
| Deno Runtime | ~150 MB | Edge Functions (待实现) |
| PgBouncer | ~50 MB | 连接池 (待实现) |
| **总计** | **~1,650 MB** |

---

## 3. 生产环境推荐配置

| 规模 | Supabase 自托管 | Druvia |
|------|-----------------|--------|
| 最小 | 4 vCPU / 8 GB | 2 vCPU / 4 GB |
| 推荐 | 4 vCPU / 16 GB | 4 vCPU / 8 GB |
| 高负载 | 8+ vCPU / 32 GB | 4+ vCPU / 16 GB |

---

## 4. 反向代理 (Nginx) 需求分析

### 4.1 是否必须?

**不是必须，但生产环境强烈推荐。**

### 4.2 无 Nginx 的可行方案

| 场景 | 方案 |
|------|------|
| 云部署 | 使用云负载均衡器 (ALB/CLB) 做 SSL 终止 |
| 单机部署 | Hasura/Fastify 直接处理 HTTPS |
| 容器编排 | Kubernetes Ingress Controller |

### 4.3 推荐使用 Nginx 的理由

| 功能 | 说明 |
|------|------|
| SSL/TLS 终止 | 统一管理证书，后端服务使用 HTTP |
| 统一入口 | 单端口 (443) 路由到多个服务 |
| 静态文件 | 高效服务 Admin 前端静态资源 |
| 安全防护 | 请求过滤、DDoS 缓解、安全头 |
| 请求缓冲 | 保护后端免受慢客户端影响 |
| 日志聚合 | 统一访问日志格式 |

### 4.4 推荐生产架构

```
                    ┌─────────────────────────────────────┐
                    │            Nginx (443)              │
                    │  - SSL 终止                         │
                    │  - 安全头                           │
                    │  - 请求限流                         │
                    └──────────────┬──────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
          ▼                        ▼                        ▼
   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐
   │   Hasura    │         │  Node.js    │         │   Admin     │
   │   (8080)    │         │  API (3001) │         │   (3000)    │
   │  GraphQL    │         │  管理接口    │         │  静态文件   │
   └──────┬──────┘         └──────┬──────┘         └─────────────┘
          │                       │
          └───────────┬───────────┘
                      ▼
              ┌─────────────┐
              │ PostgreSQL  │
              │   (5432)    │
              └─────────────┘
```

### 4.5 Nginx 资源占用

| 配置 | 内存 |
|------|------|
| 基础配置 | ~10-20 MB |
| 高并发 (worker_connections 4096) | ~50-100 MB |

相比 Kong 的 2.5 GB，Nginx 资源占用可忽略不计。

### 4.6 替代方案

| 方案 | 适用场景 | 资源占用 |
|------|----------|----------|
| Nginx | 通用、推荐 | ~20 MB |
| Caddy | 自动 HTTPS、简单配置 | ~30 MB |
| Traefik | 容器环境、动态配置 | ~50 MB |
| 云 LB | 云原生部署 | 0 (托管) |

---

## 5. 结论

### 5.1 资源效率

| 指标 | Supabase | Druvia | 节省 |
|------|----------|--------|------|
| 最小内存 | 4.2 GB | 1.7 GB | **60%** |
| 服务数量 | 12+ | 5-6 | **50%** |
| 运维复杂度 | 高 | 中 | - |

### 5.2 Druvia 轻量化原因

1. **无 Kong 网关** - 节省 2.5 GB 内存
2. **Hasura 整合** - 一个服务替代 PostgREST + Realtime
3. **适配器模式** - Storage/Auth 集成在 API 中
4. **按需加载** - 不强制启用 Analytics 等可选服务

### 5.3 生产部署建议

| 部署方式 | 推荐配置 |
|----------|----------|
| 单机 | Nginx + Docker Compose |
| 云服务 | ALB + ECS/EC2 |
| Kubernetes | Ingress + Deployment |

---

## 参考资料

- [Supabase Self-Hosting Guide](https://supabase.com/docs/guides/self-hosting)
- [Hasura Production Checklist](https://hasura.io/docs/latest/deployment/production-checklist/)
- [Nginx Performance Tuning](https://nginx.org/en/docs/)
