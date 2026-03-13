-- 006_project_db_credentials.down.sql
DROP INDEX IF EXISTS idx_druvia_projects_db_user;
ALTER TABLE druvia_projects DROP COLUMN IF EXISTS db_user;
ALTER TABLE druvia_projects DROP COLUMN IF EXISTS db_password_hash;
ALTER TABLE druvia_projects DROP COLUMN IF EXISTS db_created_at;
