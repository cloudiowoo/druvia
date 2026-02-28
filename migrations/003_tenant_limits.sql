-- migrations/003_tenant_limits.sql
-- Add description and limit columns to druvia_tenants

ALTER TABLE druvia_tenants
ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE druvia_tenants
ADD COLUMN IF NOT EXISTS storage_limit BIGINT DEFAULT 1073741824;

ALTER TABLE druvia_tenants
ADD COLUMN IF NOT EXISTS project_limit INT DEFAULT 5;

ALTER TABLE druvia_tenants
ADD COLUMN IF NOT EXISTS user_limit INT DEFAULT 10;

COMMENT ON COLUMN druvia_tenants.storage_limit IS 'Storage limit in bytes, default 1GB';
COMMENT ON COLUMN druvia_tenants.project_limit IS 'Max projects per tenant';
COMMENT ON COLUMN druvia_tenants.user_limit IS 'Max users per tenant';
