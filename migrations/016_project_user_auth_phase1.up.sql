BEGIN;

CREATE TABLE IF NOT EXISTS druvia_project_refresh_tokens (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_refresh_tokens_project_user
  ON druvia_project_refresh_tokens(project_id, user_id);

CREATE INDEX IF NOT EXISTS idx_project_refresh_tokens_expires
  ON druvia_project_refresh_tokens(expires_at)
  WHERE revoked = false;

COMMIT;
