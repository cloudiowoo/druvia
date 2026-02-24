---
name: docker-guide
description: This skill should be used when the user asks about "docker services", "container configuration", "docker-compose", "postgres container", "redis container", "hasura container", or mentions "Docker environment", "service ports", "container restart".
---

# Docker Environment Guide

Druvia 平台 Docker 服务配置指南。

## Docker Services

| Service | Container | Port | Purpose |
|---------|-----------|------|---------|
| API | `druvia-api` | 3001 | Node.js Fastify API |
| Admin | `druvia-admin` | 3000 | Next.js 管理界面 |
| Hasura | `hasura` | 8080 | GraphQL 引擎 |
| Database | `postgres` | 5432 | PostgreSQL 17 |
| Cache | `redis` | 6379 | Redis 7 缓存 |

## Essential Commands

### Start Environment

```bash
cd docker
docker-compose up -d
```

### View Logs

```bash
docker-compose logs -f api
docker-compose logs -f hasura
docker-compose logs -f postgres
```

### Database Access

```bash
# 进入 PostgreSQL
docker exec -it postgres psql -U druvia -d druvia

# 查看租户 Schema
\dn tenant_*

# 查看表
\dt druvia_*
```

### Restart Services

```bash
# 重启单个服务
docker-compose restart api

# 重启所有服务
docker-compose restart
```

### Full Reset

```bash
# 停止并删除数据卷（危险！会丢失数据）
docker-compose down -v

# 重新启动
docker-compose up -d
```

## Health Checks

```bash
# API 健康检查
curl http://localhost:3001/health

# Hasura 健康检查
curl http://localhost:8080/healthz

# PostgreSQL 连接测试
docker exec -it postgres pg_isready -U druvia
```

## Environment Variables

关键环境变量配置：

### .env 文件位置

```
druvia/
├── .env              # Node.js 应用使用 (API, Admin)
└── docker/
    └── .env          # docker-compose 使用
```

**重要**: 两个 .env 文件需要保持同步，或使用符号链接。

### 必需变量

```bash
# Database
POSTGRES_PASSWORD=your_secure_password

# Hasura
HASURA_ADMIN_SECRET=your_hasura_secret

# JWT
JWT_SECRET=your_jwt_secret_min_32_chars

# Storage
STORAGE_PROVIDER=local  # local | r2 | s3
```

## Troubleshooting

### Hasura 无法连接数据库

```bash
# 检查 PostgreSQL 是否就绪
docker-compose logs postgres | tail -20

# 确认网络连通性
docker exec -it hasura ping postgres
```

### API 启动失败

```bash
# 查看详细日志
docker-compose logs api --tail 50

# 检查依赖服务
docker-compose ps
```
