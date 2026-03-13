-- migrations/010_create_default_tenant.sql
-- Create default tenant for single-tenant mode

-- Ensure admin user exists first (use existing admin or create placeholder)
INSERT INTO druvia_users (user_id, email, username, password_hash, role)
VALUES ('admin', 'admin@druvia.local', 'Admin', '', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Create default tenant with admin as owner
INSERT INTO druvia_tenants (tenant_id, alias, name, owner_uid)
SELECT 'default', 'default', 'Default Tenant', id
FROM druvia_users WHERE email = 'admin@druvia.local'
ON CONFLICT (tenant_id) DO NOTHING;
