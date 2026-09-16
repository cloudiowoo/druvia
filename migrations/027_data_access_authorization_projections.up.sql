BEGIN;

ALTER TABLE druvia_data_access_managed_policies
  DROP CONSTRAINT druvia_data_access_managed_policies_policy_version_check;

ALTER TABLE druvia_data_access_managed_policies
  ADD COLUMN dependency_snapshot JSONB,
  ADD COLUMN dependency_digest CHAR(64),
  ADD CONSTRAINT druvia_data_access_managed_policies_policy_version_check
    CHECK (policy_version IN (1, 2)),
  ADD CONSTRAINT druvia_data_access_managed_policies_dependency_digest_check
    CHECK (dependency_digest IS NULL OR dependency_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT druvia_data_access_managed_policies_v2_dependency_check
    CHECK (
      (policy_version = 1 AND dependency_snapshot IS NULL AND dependency_digest IS NULL)
      OR
      (policy_version = 2 AND dependency_snapshot IS NOT NULL AND dependency_digest IS NOT NULL)
    );

CREATE TABLE druvia_data_access_runtime_gates (
  gate_name VARCHAR(32) PRIMARY KEY CHECK (gate_name IN ('file_rollback')),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE druvia_data_access_projection_operations (
  id BIGSERIAL UNIQUE NOT NULL,
  operation_id VARCHAR(64) PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  schema_name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN (
    'preview_ready', 'applying', 'recovering', 'completed', 'failed',
    'recovery_required', 'superseded'
  )),
  phase VARCHAR(32) NOT NULL CHECK (phase IN (
    'preview', 'source_check', 'apply_metadata', 'verify_target',
    'persist_baselines', 'inspect_recovery', 'fail_closed', 'verify_fail_closed', 'completed'
  )),
  contract JSONB NOT NULL,
  baseline_revisions JSONB NOT NULL,
  source_metadata JSONB NOT NULL,
  target_metadata JSONB NOT NULL,
  dependency_snapshot JSONB NOT NULL,
  dependency_digest CHAR(64) NOT NULL CHECK (dependency_digest ~ '^[a-f0-9]{64}$'),
  source_digest CHAR(64) NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  target_digest CHAR(64) NOT NULL CHECK (target_digest ~ '^[a-f0-9]{64}$'),
  source_resource_version BIGINT NOT NULL CHECK (source_resource_version >= 0),
  target_resource_version BIGINT,
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  writer_epoch VARCHAR(64),
  write_deadline_at TIMESTAMPTZ,
  created_by VARCHAR(64) NOT NULL,
  error_code VARCHAR(64),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_data_access_projection_operations_active_project
  ON druvia_data_access_projection_operations(project_id)
  WHERE status IN ('preview_ready', 'applying', 'recovering', 'recovery_required');

CREATE INDEX idx_data_access_projection_operations_project_created
  ON druvia_data_access_projection_operations(project_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION protect_data_access_projection_operation_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.schema_name IS DISTINCT FROM OLD.schema_name
    OR NEW.contract IS DISTINCT FROM OLD.contract
    OR NEW.baseline_revisions IS DISTINCT FROM OLD.baseline_revisions
    OR NEW.source_metadata IS DISTINCT FROM OLD.source_metadata
    OR NEW.target_metadata IS DISTINCT FROM OLD.target_metadata
    OR NEW.dependency_snapshot IS DISTINCT FROM OLD.dependency_snapshot
    OR NEW.dependency_digest IS DISTINCT FROM OLD.dependency_digest
    OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
    OR NEW.target_digest IS DISTINCT FROM OLD.target_digest
    OR NEW.source_resource_version IS DISTINCT FROM OLD.source_resource_version
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Data access projection operation payload is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'druvia_data_access_projection_operations_immutable_payload';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER druvia_data_access_projection_operations_protect_update
BEFORE UPDATE ON druvia_data_access_projection_operations
FOR EACH ROW EXECUTE FUNCTION protect_data_access_projection_operation_update();

CREATE OR REPLACE FUNCTION guard_data_access_projection_operation_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('applying', 'recovering', 'recovery_required') THEN
    RAISE EXCEPTION 'Active data access projection operation cannot be deleted'
      USING ERRCODE = '55006',
            CONSTRAINT = 'druvia_data_access_projection_operations_inflight_delete_guard';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER druvia_data_access_projection_operations_guard_delete
BEFORE DELETE ON druvia_data_access_projection_operations
FOR EACH ROW EXECUTE FUNCTION guard_data_access_projection_operation_delete();

COMMIT;
