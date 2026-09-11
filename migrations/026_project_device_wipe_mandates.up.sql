BEGIN;

CREATE TABLE druvia_project_device_wipe_configs (
  project_id TEXT PRIMARY KEY
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  register_function VARCHAR(63) NOT NULL DEFAULT 'druvia_register_device_wipe_binding',
  query_function VARCHAR(63) NOT NULL DEFAULT 'druvia_list_device_wipe_mandates',
  acknowledge_function VARCHAR(63) NOT NULL DEFAULT 'druvia_ack_device_wipe_mandate',
  binding_secret_verification CHAR(43),
  credential_secret_verification CHAR(43),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (register_function ~ '^[a-z_][a-z0-9_]{0,62}$'),
  CHECK (query_function ~ '^[a-z_][a-z0-9_]{0,62}$'),
  CHECK (acknowledge_function ~ '^[a-z_][a-z0-9_]{0,62}$'),
  CHECK (
    (binding_secret_verification IS NULL AND credential_secret_verification IS NULL)
    OR (
      binding_secret_verification ~ '^[A-Za-z0-9_-]{43}$'
      AND credential_secret_verification ~ '^[A-Za-z0-9_-]{43}$'
    )
  )
);

CREATE TABLE druvia_project_device_wipe_signing_keys (
  project_id TEXT NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  key_id VARCHAR(128) NOT NULL,
  algorithm VARCHAR(16) NOT NULL DEFAULT 'Ed25519' CHECK (algorithm = 'Ed25519'),
  public_jwk JSONB NOT NULL,
  private_jwk_encrypted TEXT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'verification_only', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, key_id),
  CHECK (key_id ~ '^[A-Za-z0-9._-]{1,128}$'),
  CHECK (public_jwk->>'kty' = 'OKP'),
  CHECK (public_jwk->>'crv' = 'Ed25519'),
  CHECK (public_jwk ? 'x'),
  CHECK (NOT public_jwk ? 'd'),
  CHECK (
    (status = 'retired' AND retired_at IS NOT NULL)
    OR (status <> 'retired' AND retired_at IS NULL)
  )
);

CREATE UNIQUE INDEX idx_project_device_wipe_active_signing_key
ON druvia_project_device_wipe_signing_keys(project_id)
WHERE status = 'active';

CREATE TABLE druvia_project_device_wipe_bindings (
  binding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE RESTRICT,
  project_user_fingerprint CHAR(43) NOT NULL,
  project_user_id_encrypted TEXT NOT NULL,
  binding_identity_hmac CHAR(43) NOT NULL,
  binding_revision BIGINT NOT NULL CHECK (binding_revision > 0),
  binding_handle VARCHAR(48) NOT NULL,
  lookup_token_hash CHAR(64) NOT NULL,
  idempotency_key UUID NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired')),
  project_schema TEXT NOT NULL,
  register_function VARCHAR(63) NOT NULL,
  register_contract_hash CHAR(64) NOT NULL,
  query_function VARCHAR(63) NOT NULL,
  query_contract_hash CHAR(64) NOT NULL,
  acknowledge_function VARCHAR(63) NOT NULL,
  acknowledge_contract_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  UNIQUE (project_id, binding_handle),
  UNIQUE (project_id, binding_id),
  UNIQUE (project_id, project_user_fingerprint, idempotency_key),
  UNIQUE (project_id, binding_identity_hmac, binding_revision),
  CHECK (project_user_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  CHECK (binding_identity_hmac ~ '^[A-Za-z0-9_-]{43}$'),
  CHECK (binding_handle ~ '^dwb_[A-Za-z0-9_-]{22,43}$'),
  CHECK (lookup_token_hash ~ '^[a-f0-9]{64}$'),
  CHECK (project_schema ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  CHECK (register_function ~ '^[a-z_][a-z0-9_]{0,62}$'),
  CHECK (register_contract_hash ~ '^[a-f0-9]{64}$'),
  CHECK (query_function ~ '^[a-z_][a-z0-9_]{0,62}$'),
  CHECK (query_contract_hash ~ '^[a-f0-9]{64}$'),
  CHECK (acknowledge_function ~ '^[a-z_][a-z0-9_]{0,62}$'),
  CHECK (acknowledge_contract_hash ~ '^[a-f0-9]{64}$'),
  CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  )
);

CREATE INDEX idx_project_device_wipe_bindings_identity
ON druvia_project_device_wipe_bindings(project_id, binding_identity_hmac, binding_revision DESC);

CREATE TABLE druvia_project_device_wipe_mandates (
  project_id TEXT NOT NULL,
  binding_id UUID NOT NULL,
  deletion_id UUID NOT NULL,
  scope VARCHAR(16) NOT NULL CHECK (scope IN ('account', 'session')),
  session_id UUID,
  key_id VARCHAR(128) NOT NULL,
  command_json JSONB NOT NULL,
  signature VARCHAR(86) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'acknowledged')),
  receipt_json JSONB,
  receipt_digest CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, binding_id, deletion_id),
  FOREIGN KEY (project_id, binding_id)
    REFERENCES druvia_project_device_wipe_bindings(project_id, binding_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, key_id)
    REFERENCES druvia_project_device_wipe_signing_keys(project_id, key_id) ON DELETE RESTRICT,
  CHECK (
    (scope = 'account' AND session_id IS NULL)
    OR (scope = 'session' AND session_id IS NOT NULL)
  ),
  CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  CHECK (
    (status = 'pending' AND receipt_json IS NULL AND receipt_digest IS NULL AND acknowledged_at IS NULL)
    OR (
      status = 'acknowledged'
      AND receipt_json IS NOT NULL
      AND receipt_digest ~ '^[a-f0-9]{64}$'
      AND acknowledged_at IS NOT NULL
    )
  )
);

CREATE INDEX idx_project_device_wipe_pending_mandates
ON druvia_project_device_wipe_mandates(project_id, binding_id, created_at)
WHERE status = 'pending';

CREATE OR REPLACE FUNCTION guard_project_device_wipe_binding_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $device_wipe_binding_transition$
BEGIN
  IF NEW.binding_id IS DISTINCT FROM OLD.binding_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.project_user_fingerprint IS DISTINCT FROM OLD.project_user_fingerprint
    OR NEW.project_user_id_encrypted IS DISTINCT FROM OLD.project_user_id_encrypted
    OR NEW.binding_identity_hmac IS DISTINCT FROM OLD.binding_identity_hmac
    OR NEW.binding_revision IS DISTINCT FROM OLD.binding_revision
    OR NEW.binding_handle IS DISTINCT FROM OLD.binding_handle
    OR NEW.lookup_token_hash IS DISTINCT FROM OLD.lookup_token_hash
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.project_schema IS DISTINCT FROM OLD.project_schema
    OR NEW.register_function IS DISTINCT FROM OLD.register_function
    OR NEW.register_contract_hash IS DISTINCT FROM OLD.register_contract_hash
    OR NEW.query_function IS DISTINCT FROM OLD.query_function
    OR NEW.query_contract_hash IS DISTINCT FROM OLD.query_contract_hash
    OR NEW.acknowledge_function IS DISTINCT FROM OLD.acknowledge_function
    OR NEW.acknowledge_contract_hash IS DISTINCT FROM OLD.acknowledge_contract_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'project device wipe binding identity is immutable'
      USING ERRCODE = '55006';
  END IF;

  IF NOT (
    (OLD.status = 'active' AND NEW.status IN ('active', 'retired'))
    OR (OLD.status = 'retired' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid project device wipe binding state transition'
      USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END
$device_wipe_binding_transition$;

CREATE TRIGGER guard_project_device_wipe_binding_transition
BEFORE UPDATE ON druvia_project_device_wipe_bindings
FOR EACH ROW
EXECUTE FUNCTION guard_project_device_wipe_binding_transition();

CREATE OR REPLACE FUNCTION guard_project_device_wipe_mandate_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $device_wipe_mandate_transition$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
    OR NEW.deletion_id IS DISTINCT FROM OLD.deletion_id
    OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.key_id IS DISTINCT FROM OLD.key_id
    OR NEW.command_json IS DISTINCT FROM OLD.command_json
    OR NEW.signature IS DISTINCT FROM OLD.signature
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'project device wipe mandate identity is immutable'
      USING ERRCODE = '55006';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'acknowledged' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status
    AND NEW.receipt_json IS NOT DISTINCT FROM OLD.receipt_json
    AND NEW.receipt_digest IS NOT DISTINCT FROM OLD.receipt_digest
    AND NEW.acknowledged_at IS NOT DISTINCT FROM OLD.acknowledged_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid project device wipe mandate state transition'
    USING ERRCODE = '55006';
END
$device_wipe_mandate_transition$;

CREATE TRIGGER guard_project_device_wipe_mandate_transition
BEFORE UPDATE ON druvia_project_device_wipe_mandates
FOR EACH ROW
EXECUTE FUNCTION guard_project_device_wipe_mandate_transition();

CREATE OR REPLACE FUNCTION guard_project_device_wipe_signing_key_retirement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $device_wipe_key_retirement$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.key_id IS DISTINCT FROM OLD.key_id
    OR NEW.algorithm IS DISTINCT FROM OLD.algorithm
    OR NEW.public_jwk IS DISTINCT FROM OLD.public_jwk
    OR NEW.private_jwk_encrypted IS DISTINCT FROM OLD.private_jwk_encrypted
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'project device wipe signing key identity is immutable'
      USING ERRCODE = '55006';
  END IF;

  IF NEW.status = 'retired' AND OLD.status <> 'retired' AND EXISTS (
    SELECT 1
    FROM druvia_project_device_wipe_mandates mandate
    WHERE mandate.project_id = OLD.project_id
      AND mandate.key_id = OLD.key_id
      AND mandate.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'cannot retire a project device wipe signing key with pending mandates'
      USING ERRCODE = '55006';
  END IF;

  IF NOT (
    (OLD.status = 'active' AND NEW.status IN ('active', 'verification_only', 'retired'))
    OR (OLD.status = 'verification_only' AND NEW.status IN ('verification_only', 'retired'))
    OR (OLD.status = 'retired' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid project device wipe signing key state transition'
      USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END
$device_wipe_key_retirement$;

CREATE TRIGGER guard_project_device_wipe_signing_key_retirement
BEFORE UPDATE ON druvia_project_device_wipe_signing_keys
FOR EACH ROW
EXECUTE FUNCTION guard_project_device_wipe_signing_key_retirement();

COMMENT ON TABLE druvia_project_device_wipe_bindings IS
  'Session-independent possession credentials and irreversible project device identities';
COMMENT ON TABLE druvia_project_device_wipe_mandates IS
  'Immutable signed device wipe commands and idempotent receipt evidence';

COMMIT;
