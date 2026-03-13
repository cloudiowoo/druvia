-- 001_init_druvia.down.sql
-- WARNING: 回滚将删除所有核心表和数据

BEGIN;

-- 先删触发器
DROP TRIGGER IF EXISTS druvia_tenant_storage_config_updated_at ON druvia_tenant_storage_config;
DROP TRIGGER IF EXISTS druvia_tenant_auth_providers_updated_at ON druvia_tenant_auth_providers;
DROP TRIGGER IF EXISTS druvia_files_updated_at ON druvia_files;
DROP TRIGGER IF EXISTS druvia_schema_registry_updated_at ON druvia_schema_registry;
DROP TRIGGER IF EXISTS druvia_projects_updated_at ON druvia_projects;
DROP TRIGGER IF EXISTS druvia_tenants_updated_at ON druvia_tenants;
DROP TRIGGER IF EXISTS druvia_users_updated_at ON druvia_users;

-- 按依赖顺序删表
DROP TABLE IF EXISTS druvia_user_providers CASCADE;
DROP TABLE IF EXISTS druvia_tenant_storage_config CASCADE;
DROP TABLE IF EXISTS druvia_tenant_auth_providers CASCADE;
DROP TABLE IF EXISTS druvia_files CASCADE;
DROP TABLE IF EXISTS druvia_backups CASCADE;
DROP TABLE IF EXISTS druvia_schema_registry CASCADE;
DROP TABLE IF EXISTS druvia_projects CASCADE;
DROP TABLE IF EXISTS druvia_tenants CASCADE;
DROP TABLE IF EXISTS druvia_users CASCADE;

DROP FUNCTION IF EXISTS druvia_update_updated_at();

COMMIT;
