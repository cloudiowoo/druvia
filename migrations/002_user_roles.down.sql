-- 002_user_roles.down.sql
DROP INDEX IF EXISTS idx_druvia_users_role;
ALTER TABLE druvia_users DROP COLUMN IF EXISTS role;
