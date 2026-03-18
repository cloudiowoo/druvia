CREATE TABLE druvia_refresh_tokens (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(128) UNIQUE NOT NULL,
  user_id VARCHAR(64) NOT NULL REFERENCES druvia_users(user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user ON druvia_refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires ON druvia_refresh_tokens(expires_at) WHERE revoked = false;
