-- 003_tenant_limits.down.sql
ALTER TABLE druvia_tenants DROP COLUMN IF EXISTS description;
ALTER TABLE druvia_tenants DROP COLUMN IF EXISTS storage_limit;
ALTER TABLE druvia_tenants DROP COLUMN IF EXISTS project_limit;
ALTER TABLE druvia_tenants DROP COLUMN IF EXISTS user_limit;
