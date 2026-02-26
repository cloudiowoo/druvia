.PHONY: dev dev-up dev-down prod prod-up prod-down build logs clean

# Development
dev-up:
	cd docker && docker compose -f docker-compose.dev.yml up -d

dev-down:
	cd docker && docker compose -f docker-compose.dev.yml down

dev-logs:
	cd docker && docker compose -f docker-compose.dev.yml logs -f

# Production
prod-build:
	cd docker && docker compose build

prod-up:
	cd docker && docker compose up -d

prod-down:
	cd docker && docker compose down

prod-logs:
	cd docker && docker compose logs -f

# Database
db-migrate:
	cd docker && docker compose exec postgres psql -U postgres -d druvia -f /docker-entrypoint-initdb.d/001_init_druvia.sql

db-shell:
	cd docker && docker compose exec postgres psql -U postgres -d druvia

# Redis
redis-shell:
	cd docker && docker compose exec redis redis-cli

# Hasura
hasura-console:
	cd hasura && hasura console --endpoint http://localhost:8080 --admin-secret $${HASURA_ADMIN_SECRET}

hasura-apply:
	cd hasura && hasura metadata apply --endpoint http://localhost:8080 --admin-secret $${HASURA_ADMIN_SECRET}

# Clean
clean:
	cd docker && docker compose down -v --remove-orphans
	docker system prune -f

# Full reset
reset: clean dev-up
	@echo "Waiting for services to start..."
	@sleep 10
	@echo "Development environment ready!"
