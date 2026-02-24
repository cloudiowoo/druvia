-- Druvia Core Schema
-- Multi-tenant BaaS Platform with Schema-per-Tenant isolation

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- Core Tables (public schema)
-- ============================================

-- 用户表
CREATE TABLE IF NOT EXISTS druvia_users (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE,
  username VARCHAR(128),
  password_hash VARCHAR(255),
  avatar_url VARCHAR(512),
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 租户表
CREATE TABLE IF NOT EXISTS druvia_tenants (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) UNIQUE NOT NULL,
  alias VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  owner_uid INT NOT NULL REFERENCES druvia_users(id),
  plan VARCHAR(20) DEFAULT 'free',
  settings JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 项目表
CREATE TABLE IF NOT EXISTS druvia_projects (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(64) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id) ON DELETE CASCADE,
  alias VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  schema_name VARCHAR(128),
  settings JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, alias)
);

-- Schema 注册表
CREATE TABLE IF NOT EXISTS druvia_schema_registry (
  id SERIAL PRIMARY KEY,
  schema_name VARCHAR(128) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id) ON DELETE CASCADE,
  project_id VARCHAR(64) REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  schema_type VARCHAR(20) NOT NULL,
  table_count INT DEFAULT 0,
  function_count INT DEFAULT 0,
  view_count INT DEFAULT 0,
  size_bytes BIGINT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 备份记录表
CREATE TABLE IF NOT EXISTS druvia_backups (
  id SERIAL PRIMARY KEY,
  backup_id VARCHAR(64) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id) ON DELETE CASCADE,
  project_id VARCHAR(64) REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  schema_name VARCHAR(128) NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  size_bytes BIGINT DEFAULT 0,
  tables_count INT DEFAULT 0,
  tables_list JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'pending',
  error_message TEXT,
  created_by INT REFERENCES druvia_users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- 文件元数据表
CREATE TABLE IF NOT EXISTS druvia_files (
  id SERIAL PRIMARY KEY,
  file_id VARCHAR(64) UNIQUE NOT NULL,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id) ON DELETE CASCADE,
  project_id VARCHAR(64) REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  bucket VARCHAR(128) NOT NULL,
  path VARCHAR(1024) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(128),
  size_bytes BIGINT DEFAULT 0,
  storage_provider VARCHAR(20) DEFAULT 'local',
  storage_key VARCHAR(512),
  metadata JSONB DEFAULT '{}',
  created_by INT REFERENCES druvia_users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 租户认证配置表
CREATE TABLE IF NOT EXISTS druvia_tenant_auth_providers (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES druvia_tenants(tenant_id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, provider)
);

-- 租户存储配置表
CREATE TABLE IF NOT EXISTS druvia_tenant_storage_config (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR(64) UNIQUE NOT NULL REFERENCES druvia_tenants(tenant_id) ON DELETE CASCADE,
  provider VARCHAR(20) DEFAULT 'local',
  config JSONB NOT NULL DEFAULT '{}',
  max_file_size_bytes BIGINT DEFAULT 52428800,
  allowed_mime_types TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 用户第三方账号绑定表
CREATE TABLE IF NOT EXISTS druvia_user_providers (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES druvia_users(user_id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL,
  provider_id VARCHAR(255) NOT NULL,
  provider_data JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(provider, provider_id)
);

-- ============================================
-- Indexes
-- ============================================

CREATE INDEX IF NOT EXISTS idx_druvia_users_email ON druvia_users(email);
CREATE INDEX IF NOT EXISTS idx_druvia_users_status ON druvia_users(status);

CREATE INDEX IF NOT EXISTS idx_druvia_tenants_owner ON druvia_tenants(owner_uid);
CREATE INDEX IF NOT EXISTS idx_druvia_tenants_alias ON druvia_tenants(alias);
CREATE INDEX IF NOT EXISTS idx_druvia_tenants_status ON druvia_tenants(status);

CREATE INDEX IF NOT EXISTS idx_druvia_projects_tenant ON druvia_projects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_druvia_projects_status ON druvia_projects(status);

CREATE INDEX IF NOT EXISTS idx_druvia_schema_tenant ON druvia_schema_registry(tenant_id);
CREATE INDEX IF NOT EXISTS idx_druvia_schema_project ON druvia_schema_registry(project_id);

CREATE INDEX IF NOT EXISTS idx_druvia_backups_tenant ON druvia_backups(tenant_id);
CREATE INDEX IF NOT EXISTS idx_druvia_backups_status ON druvia_backups(status);

CREATE INDEX IF NOT EXISTS idx_druvia_files_tenant ON druvia_files(tenant_id);
CREATE INDEX IF NOT EXISTS idx_druvia_files_bucket ON druvia_files(bucket);

CREATE INDEX IF NOT EXISTS idx_druvia_user_providers_user ON druvia_user_providers(user_id);
CREATE INDEX IF NOT EXISTS idx_druvia_user_providers_provider ON druvia_user_providers(provider, provider_id);

-- ============================================
-- Triggers
-- ============================================

CREATE OR REPLACE FUNCTION druvia_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER druvia_users_updated_at
  BEFORE UPDATE ON druvia_users
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

CREATE TRIGGER druvia_tenants_updated_at
  BEFORE UPDATE ON druvia_tenants
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

CREATE TRIGGER druvia_projects_updated_at
  BEFORE UPDATE ON druvia_projects
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

CREATE TRIGGER druvia_schema_registry_updated_at
  BEFORE UPDATE ON druvia_schema_registry
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

CREATE TRIGGER druvia_files_updated_at
  BEFORE UPDATE ON druvia_files
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

CREATE TRIGGER druvia_tenant_auth_providers_updated_at
  BEFORE UPDATE ON druvia_tenant_auth_providers
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

CREATE TRIGGER druvia_tenant_storage_config_updated_at
  BEFORE UPDATE ON druvia_tenant_storage_config
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

-- ============================================
-- Initial Data (for development)
-- ============================================

-- Create a default admin user
INSERT INTO druvia_users (user_id, email, username, status)
VALUES ('usr_admin', 'admin@druvia.local', 'admin', 'active')
ON CONFLICT (user_id) DO NOTHING;
