BEGIN;

CREATE TABLE druvia_project_auth_identities (
  id BIGSERIAL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  project_user_id TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  audience TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  email_forwarding_status VARCHAR(16) NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_authenticated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT druvia_project_auth_identities_status_check
    CHECK (status IN ('active', 'revoke_pending', 'revoked', 'deletion_pending')),
  CONSTRAINT druvia_project_auth_identities_email_forwarding_check
    CHECK (email_forwarding_status IN ('unknown', 'enabled', 'disabled')),
  CONSTRAINT druvia_project_auth_identities_unique_subject
    UNIQUE (project_id, provider, issuer, subject)
);

CREATE INDEX idx_project_auth_identities_project_user
  ON druvia_project_auth_identities(project_id, project_user_id);

CREATE TABLE druvia_project_auth_provider_tokens (
  id BIGSERIAL PRIMARY KEY,
  identity_id BIGINT NOT NULL
    REFERENCES druvia_project_auth_identities(id) ON DELETE CASCADE,
  audience TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  last_validated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT druvia_project_auth_provider_tokens_identity_audience_key
    UNIQUE (identity_id, audience)
);

CREATE TABLE druvia_project_auth_events (
  id BIGSERIAL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  identity_id BIGINT
    REFERENCES druvia_project_auth_identities(id) ON DELETE SET NULL,
  project_user_id TEXT,
  provider VARCHAR(32) NOT NULL,
  issuer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'handled',
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  CONSTRAINT druvia_project_auth_events_status_check
    CHECK (status IN ('handled', 'application_action_pending', 'acknowledged')),
  CONSTRAINT druvia_project_auth_events_unique_event
    UNIQUE (provider, issuer, event_id)
);

CREATE INDEX idx_project_auth_events_project_status
  ON druvia_project_auth_events(project_id, status, id);

ALTER TABLE druvia_project_refresh_tokens
  ADD COLUMN identity_id BIGINT
    REFERENCES druvia_project_auth_identities(id) ON DELETE CASCADE,
  ADD COLUMN provider_audience TEXT;

CREATE INDEX idx_project_refresh_tokens_identity
  ON druvia_project_refresh_tokens(identity_id)
  WHERE revoked = false AND identity_id IS NOT NULL;

ALTER TABLE druvia_project_refresh_tokens
  ADD CONSTRAINT druvia_project_refresh_tokens_apple_identity_check
  CHECK (
    provider <> 'apple'
    OR (identity_id IS NOT NULL AND provider_audience IS NOT NULL)
  );

COMMIT;
