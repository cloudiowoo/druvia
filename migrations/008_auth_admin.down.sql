-- 008_auth_admin.down.sql
BEGIN;
DROP TRIGGER IF EXISTS druvia_project_auth_config_updated_at ON druvia_project_auth_config;
DROP TRIGGER IF EXISTS druvia_project_auth_providers_updated_at ON druvia_project_auth_providers;
DROP TABLE IF EXISTS druvia_project_auth_config;
DROP TABLE IF EXISTS druvia_project_auth_providers;
COMMIT;
