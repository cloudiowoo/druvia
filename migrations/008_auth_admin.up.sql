-- Authentication Admin 扩展迁移
-- 添加项目级认证配置表

BEGIN;

-- ============================================
-- 项目级认证提供商配置（覆盖租户级）
-- ============================================
-- 设计说明：租户级配置作为默认值，项目可通过此表覆盖

CREATE TABLE IF NOT EXISTS druvia_project_auth_providers (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,          -- google, github, wechat, dingtalk, feishu
  enabled BOOLEAN DEFAULT true,
  client_id VARCHAR(255),
  client_secret_encrypted TEXT,           -- AES-256-GCM 加密
  config JSONB DEFAULT '{}',              -- 额外配置（回调 URL、scope 等）
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, provider)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_project_auth_providers_project
  ON druvia_project_auth_providers(project_id);

-- updated_at 触发器
CREATE TRIGGER druvia_project_auth_providers_updated_at
  BEFORE UPDATE ON druvia_project_auth_providers
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

-- ============================================
-- 项目认证配置表
-- ============================================

CREATE TABLE IF NOT EXISTS druvia_project_auth_config (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(64) UNIQUE NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  jwt_expires_in INTEGER DEFAULT 3600,              -- JWT 过期时间（秒）
  refresh_token_expires_in INTEGER DEFAULT 604800,  -- Refresh Token 过期（7天）
  password_min_length INTEGER DEFAULT 8,
  require_email_verification BOOLEAN DEFAULT false,
  allow_signup BOOLEAN DEFAULT true,                -- 是否允许用户注册
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- updated_at 触发器
CREATE TRIGGER druvia_project_auth_config_updated_at
  BEFORE UPDATE ON druvia_project_auth_config
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

-- ============================================
-- 注释
-- ============================================

COMMENT ON TABLE druvia_project_auth_providers IS '项目级认证提供商配置，覆盖租户级默认值';
COMMENT ON COLUMN druvia_project_auth_providers.client_secret_encrypted IS 'AES-256-GCM 加密的 client_secret';
COMMENT ON COLUMN druvia_project_auth_providers.config IS '额外配置，如 redirect_uri、scope、endpoints 等';

COMMENT ON TABLE druvia_project_auth_config IS '项目认证配置，包含 JWT 过期时间、密码策略等';
COMMENT ON COLUMN druvia_project_auth_config.jwt_expires_in IS 'JWT 过期时间（秒），默认 1 小时';
COMMENT ON COLUMN druvia_project_auth_config.refresh_token_expires_in IS 'Refresh Token 过期时间（秒），默认 7 天';

COMMIT;
