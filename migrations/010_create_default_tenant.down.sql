-- 010_create_default_tenant.down.sql
-- 注意：如果 admin 用户是 001 创建的 usr_admin，此 DELETE 可能匹配不到 user_id='admin' 的行
-- 这是安全的 — ON CONFLICT DO NOTHING 意味着 010 可能未插入新用户
DELETE FROM druvia_tenants WHERE tenant_id = 'default';
DELETE FROM druvia_users WHERE email = 'admin@druvia.local' AND user_id = 'admin';
