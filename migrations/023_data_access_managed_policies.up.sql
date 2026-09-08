BEGIN;

CREATE TABLE druvia_data_access_managed_policies (
  project_id VARCHAR(64) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  table_name VARCHAR(128) NOT NULL,
  schema_name VARCHAR(128) NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version = 1),
  policy JSONB NOT NULL,
  column_grants JSONB NOT NULL,
  capabilities_snapshot JSONB NOT NULL,
  permissions_snapshot JSONB NOT NULL,
  metadata_digest CHAR(64) NOT NULL CHECK (metadata_digest ~ '^[a-f0-9]{64}$'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by VARCHAR(64) NOT NULL,
  updated_by VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, schema_name, table_name)
);

CREATE TABLE druvia_data_access_policy_operations (
  id BIGSERIAL UNIQUE NOT NULL,
  operation_id VARCHAR(64) PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  schema_name VARCHAR(128) NOT NULL,
  table_name VARCHAR(128) NOT NULL,
  kind VARCHAR(32) NOT NULL CHECK (kind IN ('adoption', 'policy_update', 'reconcile')),
  status VARCHAR(32) NOT NULL CHECK (status IN (
    'preview_ready', 'applying', 'recovering', 'completed', 'failed',
    'recovery_required', 'superseded'
  )),
  phase VARCHAR(32) NOT NULL CHECK (phase IN (
    'preview', 'source_check', 'persist_baseline', 'apply_permissions',
    'verify_target', 'restore_source', 'verify_source', 'completed'
  )),
  baseline_revision BIGINT,
  source_capabilities JSONB NOT NULL,
  source_permissions JSONB NOT NULL,
  source_digest CHAR(64) NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  source_resource_version BIGINT NOT NULL CHECK (source_resource_version >= 0),
  target_policy JSONB,
  target_column_grants JSONB,
  target_capabilities JSONB,
  target_permissions JSONB,
  target_digest CHAR(64),
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((target_digest IS NULL) = (target_permissions IS NULL))
);

CREATE UNIQUE INDEX idx_data_access_policy_operations_active_project
  ON druvia_data_access_policy_operations(project_id)
  WHERE status IN ('preview_ready', 'applying', 'recovering', 'recovery_required');

CREATE INDEX idx_data_access_policy_operations_project_created
  ON druvia_data_access_policy_operations(project_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION protect_data_access_policy_operation_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.schema_name IS DISTINCT FROM OLD.schema_name
    OR NEW.table_name IS DISTINCT FROM OLD.table_name
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.baseline_revision IS DISTINCT FROM OLD.baseline_revision
    OR NEW.source_capabilities IS DISTINCT FROM OLD.source_capabilities
    OR NEW.source_permissions IS DISTINCT FROM OLD.source_permissions
    OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
    OR NEW.source_resource_version IS DISTINCT FROM OLD.source_resource_version
    OR NEW.target_policy IS DISTINCT FROM OLD.target_policy
    OR NEW.target_column_grants IS DISTINCT FROM OLD.target_column_grants
    OR NEW.target_capabilities IS DISTINCT FROM OLD.target_capabilities
    OR NEW.target_permissions IS DISTINCT FROM OLD.target_permissions
    OR NEW.target_digest IS DISTINCT FROM OLD.target_digest
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Data access policy operation payload is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'druvia_data_access_policy_operations_immutable_payload';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER druvia_data_access_policy_operations_protect_update
BEFORE UPDATE ON druvia_data_access_policy_operations
FOR EACH ROW EXECUTE FUNCTION protect_data_access_policy_operation_update();

CREATE OR REPLACE FUNCTION guard_data_access_policy_operation_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('applying', 'recovering', 'recovery_required') THEN
    RAISE EXCEPTION 'Active data access policy operation cannot be deleted'
      USING ERRCODE = '55006',
            CONSTRAINT = 'druvia_data_access_policy_operations_inflight_delete_guard';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER druvia_data_access_policy_operations_guard_delete
BEFORE DELETE ON druvia_data_access_policy_operations
FOR EACH ROW EXECUTE FUNCTION guard_data_access_policy_operation_delete();

COMMIT;
