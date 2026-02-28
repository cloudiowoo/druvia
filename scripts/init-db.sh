#!/bin/bash
# 数据库初始化脚本 - 按顺序执行所有迁移文件
# 用法: ./scripts/init-db.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MIGRATIONS_DIR="$PROJECT_ROOT/migrations"

# Docker 容器名称
CONTAINER="druvia-postgres"
DB_USER="postgres"
DB_NAME="druvia"

echo "=== Druvia 数据库初始化 ==="
echo "迁移目录: $MIGRATIONS_DIR"
echo ""

# 检查容器是否运行
if ! docker ps | grep -q "$CONTAINER"; then
    echo "错误: PostgreSQL 容器 '$CONTAINER' 未运行"
    echo "请先启动: cd docker && docker-compose up -d"
    exit 1
fi

# 等待 PostgreSQL 就绪
echo "等待 PostgreSQL 就绪..."
for i in {1..30}; do
    if docker exec "$CONTAINER" pg_isready -U "$DB_USER" > /dev/null 2>&1; then
        echo "PostgreSQL 已就绪"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "错误: PostgreSQL 启动超时"
        exit 1
    fi
    sleep 1
done

# 按顺序执行迁移文件
echo ""
echo "执行迁移文件..."
for migration in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
    filename=$(basename "$migration")
    echo "  -> $filename"
    docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" < "$migration"
done

echo ""
echo "=== 数据库初始化完成 ==="
echo ""
echo "验证表结构:"
docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "\dt druvia_*"
