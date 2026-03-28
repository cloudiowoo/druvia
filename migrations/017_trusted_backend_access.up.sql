CREATE TABLE IF NOT EXISTS druvia_trusted_backend_keys (
  id BIGSERIAL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix VARCHAR(32) NOT NULL,
  name TEXT NULL,
  scopes TEXT[] NOT NULL,
  created_by TEXT NULL,
  last_used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trusted_backend_keys_project_created_at
  ON druvia_trusted_backend_keys(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trusted_backend_keys_project_key_prefix
  ON druvia_trusted_backend_keys(project_id, key_prefix);
