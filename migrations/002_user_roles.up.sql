-- migrations/002_user_roles.sql
-- Add role column to druvia_users

ALTER TABLE druvia_users
ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'admin';

-- Update existing admin user to super_admin
UPDATE druvia_users
SET role = 'super_admin'
WHERE user_id = 'usr_admin';

-- Add index for role queries
CREATE INDEX IF NOT EXISTS idx_druvia_users_role ON druvia_users(role);

COMMENT ON COLUMN druvia_users.role IS 'User role: super_admin or admin';
