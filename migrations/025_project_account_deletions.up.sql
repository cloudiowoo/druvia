BEGIN;

ALTER TABLE druvia_project_auth_identities
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0);

CREATE TABLE druvia_project_account_deletion_configs (
  project_id VARCHAR(64) PRIMARY KEY
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  cleanup_mode VARCHAR(24) NOT NULL DEFAULT 'database_function'
    CHECK (cleanup_mode = 'database_function'),
  cleanup_function TEXT NOT NULL DEFAULT 'druvia_delete_project_user_data'
    CHECK (cleanup_function ~ '^[a-z_][a-z0-9_]{0,62}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE druvia_project_account_deletions (
  deletion_id UUID PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  project_schema TEXT NOT NULL,
  project_user_id TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  issuer TEXT NOT NULL,
  identity_id BIGINT,
  source VARCHAR(32) NOT NULL DEFAULT 'project_user'
    CHECK (source IN ('project_user', 'apple_notification')),
  source_reference TEXT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  idempotency_key UUID NOT NULL,
  reauth_nonce_hash CHAR(64),
  intent_expires_at TIMESTAMPTZ,
  confirmation_lease_token UUID,
  confirmation_lease_until TIMESTAMPTZ,
  cleanup_function TEXT NOT NULL,
  cleanup_contract_hash CHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending_confirmation'
    CHECK (status IN ('pending_confirmation', 'expired', 'accepted', 'processing', 'attention_required', 'completed')),
  phase VARCHAR(32) NOT NULL DEFAULT 'awaiting_confirmation'
    CHECK (phase IN (
      'awaiting_confirmation',
      'confirmation_in_progress',
      'business_cleanup',
      'storage_cleanup',
      'project_user_cleanup',
      'provider_revoke',
      'attention_required',
      'completed'
    )),
  accepted_at TIMESTAMPTZ,
  data_deletion_deadline_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  provider_revocation_status VARCHAR(24) NOT NULL DEFAULT 'not_required'
    CHECK (provider_revocation_status IN ('not_required', 'pending', 'in_flight', 'succeeded', 'superseded')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, project_user_id, idempotency_key),
  CHECK (
    (source = 'project_user' AND reauth_nonce_hash IS NOT NULL AND intent_expires_at IS NOT NULL)
    OR (source = 'apple_notification' AND source_reference IS NOT NULL)
  ),
  CHECK (
    status IN ('pending_confirmation', 'expired')
    OR (accepted_at IS NOT NULL AND data_deletion_deadline_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_project_account_deletions_active_user
  ON druvia_project_account_deletions(project_id, project_user_id)
  WHERE status NOT IN ('expired', 'completed');

CREATE UNIQUE INDEX idx_project_account_deletions_source_reference
  ON druvia_project_account_deletions(source, source_reference)
  WHERE source_reference IS NOT NULL;

CREATE INDEX idx_project_account_deletions_due
  ON druvia_project_account_deletions(status, next_attempt_at, created_at)
  WHERE status IN ('accepted', 'processing', 'attention_required');

CREATE TABLE druvia_project_account_deletion_fences (
  deletion_id UUID PRIMARY KEY
    REFERENCES druvia_project_account_deletions(deletion_id) ON DELETE CASCADE,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  deleted_project_user_id TEXT NOT NULL,
  provider VARCHAR(32) NOT NULL,
  issuer TEXT NOT NULL,
  subject_fingerprint CHAR(64) NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  accepted_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (project_id, deleted_project_user_id, generation),
  UNIQUE (project_id, provider, issuer, subject_fingerprint, generation)
);

CREATE INDEX idx_project_account_deletion_fences_user
  ON druvia_project_account_deletion_fences(project_id, deleted_project_user_id);

CREATE INDEX idx_project_account_deletion_fences_subject
  ON druvia_project_account_deletion_fences(project_id, provider, issuer, subject_fingerprint);

CREATE TABLE druvia_project_account_deletion_provider_tokens (
  id BIGSERIAL PRIMARY KEY,
  deletion_id UUID NOT NULL
    REFERENCES druvia_project_account_deletions(deletion_id) ON DELETE CASCADE,
  purpose VARCHAR(32) NOT NULL
    CHECK (purpose IN ('accepted_deletion', 'reauth_compensation')),
  audience TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_flight', 'superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_project_account_deletion_accepted_token
  ON druvia_project_account_deletion_provider_tokens(deletion_id, purpose)
  WHERE purpose = 'accepted_deletion';

CREATE INDEX idx_project_account_deletion_provider_tokens_due
  ON druvia_project_account_deletion_provider_tokens(status, next_attempt_at)
  WHERE status IN ('pending', 'in_flight');

CREATE TABLE druvia_project_runtime_gates (
  project_id VARCHAR(64) PRIMARY KEY
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  operation_id VARCHAR(64) NOT NULL,
  gate_type VARCHAR(32) NOT NULL CHECK (gate_type = 'backup_restore'),
  status VARCHAR(32) NOT NULL CHECK (status IN ('restoring', 'recovery_required')),
  reason_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE druvia_account_deletion_executor_heartbeats (
  instance_id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION guard_project_account_deletion_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.deletion_id IS DISTINCT FROM OLD.deletion_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.project_schema IS DISTINCT FROM OLD.project_schema
    OR NEW.project_user_id IS DISTINCT FROM OLD.project_user_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.issuer IS DISTINCT FROM OLD.issuer
    OR NEW.identity_id IS DISTINCT FROM OLD.identity_id
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
    OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.reauth_nonce_hash IS DISTINCT FROM OLD.reauth_nonce_hash
    OR NEW.intent_expires_at IS DISTINCT FROM OLD.intent_expires_at
    OR NEW.cleanup_function IS DISTINCT FROM OLD.cleanup_function
    OR NEW.cleanup_contract_hash IS DISTINCT FROM OLD.cleanup_contract_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'project account deletion identity is immutable'
      USING ERRCODE = '55006';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending_confirmation' AND NEW.status IN ('expired', 'accepted'))
    OR (OLD.status = 'accepted' AND NEW.status IN ('processing', 'attention_required'))
    OR (OLD.status = 'processing' AND NEW.status IN ('attention_required', 'completed'))
    OR (OLD.status = 'attention_required' AND NEW.status = 'processing')
  ) THEN
    RAISE EXCEPTION 'invalid project account deletion state transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '55006';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

CREATE TRIGGER guard_project_account_deletion_transition
BEFORE UPDATE ON druvia_project_account_deletions
FOR EACH ROW
EXECUTE FUNCTION guard_project_account_deletion_transition();

COMMIT;
