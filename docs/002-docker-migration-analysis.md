# Docker 部署指南

## 概述

Druvia 支持两种 Docker 部署模式：

| 模式 | 文件 | 用途 |
|------|------|------|
| 生产模式 | `docker-compose.prod.yml` | 完整镜像构建，适合生产部署 |
| 本地模式 | `docker-compose.local.yml` | 挂载本地构建，适合开发调试 |

---

## 快速开始

### 生产模式

```bash
cd docker

# 1. 配置环境变量
cp .env.prod.example .env
# 编辑 .env 填入实际值

# 2. 构建并启动
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d

# 3. 启用 nginx 反向代理（可选）
docker compose -f docker-compose.prod.yml --profile with-nginx up -d
```

### 本地开发模式

```bash
# 1. 本地构建
pnpm build

# 2. 复制静态资源到 standalone 目录
cp -r apps/admin/public apps/admin/.next/standalone/apps/admin/
cp -r apps/admin/.next/static apps/admin/.next/standalone/apps/admin/.next/

# 3. 启动服务
cd docker
docker compose -f docker-compose.local.yml --profile with-nginx up -d

# 4. 代码修改后，重新构建并重启
pnpm build
cp -r apps/admin/public apps/admin/.next/standalone/apps/admin/
cp -r apps/admin/.next/static apps/admin/.next/standalone/apps/admin/.next/
docker compose -f docker-compose.local.yml restart api admin
```

---

## 服务架构

```
┌─────────────────────────────────────────────────────────────┐
│                        nginx (:80/:443)                      │
│                     (可选，反向代理)                          │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  admin (:3000) │   │  api (:3001)  │   │ hasura (:8080)│
│   Next.js 16   │   │   Fastify 5   │   │  GraphQL API  │
└───────────────┘   └───────────────┘   └───────────────┘
                              │                     │
                    ┌─────────┴─────────┐           │
                    ▼                   ▼           │
            ┌───────────────┐   ┌───────────────┐   │
            │postgres (:5432)│   │ redis (:6379) │   │
            │  PostgreSQL 17 │   │   Redis 7     │◄──┘
            └───────────────┘   └───────────────┘
```

---

## 环境变量

### 必需变量

```bash
# docker/.env
POSTGRES_PASSWORD=your-secure-password
POSTGRES_PASSWORD_ENCODED=your-secure-password  # URL 编码版本
JWT_SECRET=your-jwt-secret-min-32-chars
HASURA_ADMIN_SECRET=your-hasura-admin-secret
```

### 前端 API 地址

生产环境使用 nginx 反向代理时，前端 API 地址应为空（使用相对路径）：

```bash
# 生产环境（通过 nginx）
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_HASURA_URL=

# 本地开发（直连）
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_HASURA_URL=http://localhost:8080
```

---

## 访问地址

启用 nginx 后：

| 服务 | 地址 |
|------|------|
| Admin UI | http://localhost/ |
| API | http://localhost/api/ |
| GraphQL | http://localhost/v1/graphql |
| Hasura Console | http://localhost:8080/console (需单独暴露端口) |

---

## 数据持久化

所有数据存储在主机目录：

```
docker/
├── postgres_data/    # PostgreSQL 数据
├── redis_data/       # Redis AOF 持久化
├── deno_cache/       # Deno 模块缓存
└── nginx/ssl/        # SSL 证书（如需 HTTPS）
```

---

## 常用命令

```bash
# 查看服务状态
docker compose -f docker-compose.prod.yml ps

# 查看日志
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f admin

# 重启单个服务
docker compose -f docker-compose.prod.yml restart api

# 停止所有服务
docker compose -f docker-compose.prod.yml down

# 重建单个镜像
docker compose -f docker-compose.prod.yml build api --no-cache
```

---

## 从 PM2 迁移

### 迁移前检查

1. 确保 `pnpm build` 成功（无 TypeScript 错误）
2. 备份现有数据库
3. 准备环境变量配置

### 迁移步骤

1. 停止 PM2 服务：`pm2 stop all`
2. 配置 Docker 环境变量
3. 启动 Docker 服务
4. 验证功能正常
5. 删除 PM2 配置：`pm2 delete all`

### 对比

| 维度 | Docker | PM2 |
|------|--------|-----|
| 部署复杂度 | 低 (一条命令) | 中 |
| 环境一致性 | 高 (完全隔离) | 中 |
| 资源隔离 | 高 (容器级别) | 低 |
| 日志管理 | 统一 | 分散 |
| 回滚能力 | 高 (镜像版本) | 中 |

---

## 故障排查

### 服务启动失败

```bash
# 检查日志
docker logs druvia-api
docker logs druvia-admin

# 检查健康状态
docker inspect druvia-api --format='{{.State.Health.Status}}'
```

### 数据库连接失败

```bash
# 检查 PostgreSQL 是否就绪
docker exec druvia-postgres pg_isready -U postgres

# 检查网络连通性
docker exec druvia-api ping postgres
```

### 前端 API 调用失败

1. 检查 `NEXT_PUBLIC_API_URL` 是否正确配置
2. 检查 nginx 配置是否正确代理 `/api/` 路径
3. 检查 API 服务是否健康

---

**更新时间**: 2026-03-11
