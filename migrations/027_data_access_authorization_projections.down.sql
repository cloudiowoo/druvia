BEGIN;

DO $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('data-access-mutation:global', 0)) THEN
    RAISE EXCEPTION 'cannot roll back migration 027 while file rollback holds the mutation lock'
      USING ERRCODE = '55006';
  END IF;
  IF EXISTS (
    SELECT 1 FROM druvia_data_access_runtime_gates
    WHERE gate_name = 'file_rollback' AND active
  ) THEN
    RAISE EXCEPTION 'cannot roll back migration 027 while a data access runtime gate is active'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

SET LOCAL lock_timeout = '1s';
LOCK TABLE druvia_data_access_runtime_gates IN ACCESS EXCLUSIVE MODE;
LOCK TABLE druvia_data_access_projection_operations IN ACCESS EXCLUSIVE MODE;
LOCK TABLE druvia_data_access_managed_policies IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM druvia_data_access_runtime_gates
    WHERE gate_name = 'file_rollback' AND active
  ) THEN
    RAISE EXCEPTION 'cannot roll back migration 027 while a data access runtime gate is active'
      USING ERRCODE = '55006';
  END IF;
  IF EXISTS (SELECT 1 FROM druvia_data_access_projection_operations)
    OR EXISTS (
      SELECT 1 FROM druvia_data_access_managed_policies
      WHERE policy_version = 2 OR dependency_snapshot IS NOT NULL OR dependency_digest IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'cannot roll back migration 027 while projection state exists'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

DROP TRIGGER druvia_data_access_projection_operations_guard_delete
  ON druvia_data_access_projection_operations;
DROP FUNCTION guard_data_access_projection_operation_delete();
DROP TRIGGER druvia_data_access_projection_operations_protect_update
  ON druvia_data_access_projection_operations;
DROP FUNCTION protect_data_access_projection_operation_update();
DROP TABLE druvia_data_access_projection_operations;
DROP TABLE druvia_data_access_runtime_gates;

ALTER TABLE druvia_data_access_managed_policies
  DROP CONSTRAINT druvia_data_access_managed_policies_v2_dependency_check,
  DROP CONSTRAINT druvia_data_access_managed_policies_dependency_digest_check,
  DROP CONSTRAINT druvia_data_access_managed_policies_policy_version_check,
  DROP COLUMN dependency_snapshot,
  DROP COLUMN dependency_digest,
  ADD CONSTRAINT druvia_data_access_managed_policies_policy_version_check
    CHECK (policy_version = 1);

COMMIT;
