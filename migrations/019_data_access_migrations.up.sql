CREATE TABLE druvia_data_access_migrations (
  id BIGSERIAL PRIMARY KEY,
  migration_id VARCHAR(64) NOT NULL UNIQUE,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL,
  phase VARCHAR(32) NOT NULL,
  source_snapshot JSONB NOT NULL,
  migration_plan JSONB NOT NULL,
  source_digest CHAR(64) NOT NULL,
  applied_snapshot JSONB,
  applied_digest CHAR(64),
  rollback_preview_digest CHAR(64),
  recovery_target VARCHAR(16),
  has_destructive_changes BOOLEAN NOT NULL DEFAULT FALSE,
  created_by VARCHAR(64) NOT NULL,
  error_code VARCHAR(64),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT druvia_data_access_migrations_status_check CHECK (
    status IN (
      'preview_ready',
      'applying',
      'applied',
      'rolling_back',
      'rolled_back',
      'recovered',
      'failed',
      'superseded'
    )
  ),
  CONSTRAINT druvia_data_access_migrations_phase_check CHECK (
    phase IN (
      'preview',
      'snapshot_check',
      'prepare_scoped_permissions',
      'verify_scoped_metadata',
      'verify_scoped_http',
      'verify_scoped_realtime',
      'remove_legacy_permissions',
      'activate_explicit_mode',
      'verify_active_runtime',
      'rollback_snapshot_check',
      'restore_permissions',
      'restore_runtime_mode',
      'verify_recovery_target',
      'completed'
    )
  ),
  CONSTRAINT druvia_data_access_migrations_recovery_target_check CHECK (
    recovery_target IS NULL OR recovery_target IN ('source', 'applied')
  ),
  CONSTRAINT druvia_data_access_migrations_applied_payload_check CHECK (
    (applied_snapshot IS NULL AND applied_digest IS NULL AND applied_at IS NULL)
    OR
    (applied_snapshot IS NOT NULL AND applied_digest IS NOT NULL AND applied_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_data_access_migrations_active_operation
  ON druvia_data_access_migrations(project_id)
  WHERE status IN ('preview_ready', 'applying', 'rolling_back')
     OR (
       status = 'failed'
       AND error_code IN (
         'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED',
         'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'
       )
     );

CREATE UNIQUE INDEX idx_data_access_migrations_rollback_candidate
  ON druvia_data_access_migrations(project_id)
  WHERE status = 'applied';

CREATE INDEX idx_data_access_migrations_project_created
  ON druvia_data_access_migrations(project_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION protect_data_access_migration_update()
RETURNS TRIGGER AS $$
DECLARE
  transition_allowed BOOLEAN := FALSE;
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
    OR NEW.migration_plan IS DISTINCT FROM OLD.migration_plan
    OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
    OR NEW.has_destructive_changes IS DISTINCT FROM OLD.has_destructive_changes
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'data access migration immutable payload cannot be changed'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.applied_snapshot IS NULL THEN
    IF NEW.applied_snapshot IS NOT NULL
      OR NEW.applied_digest IS NOT NULL
      OR NEW.applied_at IS NOT NULL
    THEN
      IF NOT (
        OLD.status = 'applying' AND NEW.status = 'applied'
        AND NEW.applied_snapshot IS NOT NULL
        AND NEW.applied_digest IS NOT NULL
        AND NEW.applied_at IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'applied migration payload can only be recorded once after apply'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  ELSIF NEW.applied_snapshot IS DISTINCT FROM OLD.applied_snapshot
    OR NEW.applied_digest IS DISTINCT FROM OLD.applied_digest
    OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
  THEN
    RAISE EXCEPTION 'applied migration payload cannot be changed'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = OLD.status THEN
    transition_allowed := TRUE;
  ELSIF OLD.status = 'preview_ready' THEN
    transition_allowed := NEW.status IN ('superseded', 'applying');
  ELSIF OLD.status = 'applying' THEN
    transition_allowed := NEW.status IN ('applied', 'failed', 'recovered');
  ELSIF OLD.status = 'applied' THEN
    transition_allowed := NEW.status = 'rolling_back';
  ELSIF OLD.status = 'rolling_back' THEN
    transition_allowed := NEW.status IN ('rolled_back', 'applied', 'failed');
  ELSIF OLD.status = 'failed'
    AND OLD.error_code = 'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED'
  THEN
    transition_allowed := NEW.status = 'applying';
  ELSIF OLD.status = 'failed'
    AND OLD.error_code = 'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'
  THEN
    transition_allowed := NEW.status = 'rolling_back';
  END IF;

  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'invalid data access migration status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'applying' AND NEW.recovery_target IS DISTINCT FROM 'source' THEN
    RAISE EXCEPTION 'applying migration must recover to source'
      USING ERRCODE = '55000';
  ELSIF NEW.status = 'rolling_back' AND NEW.recovery_target IS DISTINCT FROM 'applied' THEN
    RAISE EXCEPTION 'rolling back migration must recover to applied state'
      USING ERRCODE = '55000';
  ELSIF NEW.status = 'failed'
    AND NEW.error_code = 'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED'
    AND NEW.recovery_target IS DISTINCT FROM 'source'
  THEN
    RAISE EXCEPTION 'source recovery failure must retain its recovery target'
      USING ERRCODE = '55000';
  ELSIF NEW.status = 'failed'
    AND NEW.error_code = 'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'
    AND NEW.recovery_target IS DISTINCT FROM 'applied'
  THEN
    RAISE EXCEPTION 'applied recovery failure must retain its recovery target'
      USING ERRCODE = '55000';
  ELSIF NEW.status NOT IN ('applying', 'rolling_back')
    AND NOT (
      NEW.status = 'failed'
      AND NEW.error_code IN (
        'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED',
        'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'
      )
    )
    AND NEW.recovery_target IS NOT NULL
  THEN
    RAISE EXCEPTION 'terminal migration state cannot retain a recovery target'
      USING ERRCODE = '55000';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_data_access_migration_update
  BEFORE UPDATE ON druvia_data_access_migrations
  FOR EACH ROW
  EXECUTE FUNCTION protect_data_access_migration_update();

CREATE OR REPLACE FUNCTION guard_data_access_migration_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('applying', 'rolling_back')
    OR (
      OLD.status = 'failed'
      AND OLD.error_code IN (
        'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED',
        'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'
      )
    )
  THEN
    RAISE EXCEPTION 'cannot delete a project with an active data access migration'
      USING
        ERRCODE = '55006',
        CONSTRAINT = 'druvia_data_access_migrations_inflight_delete_guard';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER guard_data_access_migration_delete
  BEFORE DELETE ON druvia_data_access_migrations
  FOR EACH ROW
  EXECUTE FUNCTION guard_data_access_migration_delete();
