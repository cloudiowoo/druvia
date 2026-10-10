BEGIN;

SET LOCAL lock_timeout = '5s';
LOCK TABLE druvia_data_access_policy_operations IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM druvia_data_access_policy_operations WHERE kind = 'grant_extension'
  ) THEN
    RAISE EXCEPTION 'cannot roll back migration 030 while grant extension history exists'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

ALTER TABLE druvia_data_access_policy_operations
  DROP CONSTRAINT druvia_data_access_policy_operations_kind_check;
ALTER TABLE druvia_data_access_policy_operations
  ADD CONSTRAINT druvia_data_access_policy_operations_kind_check
  CHECK (kind IN ('adoption', 'policy_update', 'reconcile'));

COMMIT;
