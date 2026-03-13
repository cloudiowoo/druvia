-- migrations/011_create_api_keys.sql
-- API Keys for MCP and external integrations

CREATE TABLE IF NOT EXISTS druvia_api_keys (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(50) NOT NULL REFERENCES "public"."druvia_projects"("project_id") ON DELETE CASCADE,
  key_hash VARCHAR(64) NOT NULL,
  key_prefix VARCHAR(12) NOT NULL,
  name VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  UNIQUE(key_hash)
);

CREATE INDEX idx_api_keys_project ON druvia_api_keys(project_id);
CREATE INDEX idx_api_keys_hash ON druvia_api_keys(key_hash);
