BEGIN;

LOCK TABLE druvia_data_access_managed_policies, druvia_data_access_policy_operations
  IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM druvia_data_access_managed_policies LIMIT 1)
    OR EXISTS (SELECT 1 FROM druvia_data_access_policy_operations LIMIT 1)
  THEN
    RAISE EXCEPTION 'Cannot rollback managed data access policies while records exist'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS druvia_data_access_policy_operations_guard_delete
  ON druvia_data_access_policy_operations;
DROP FUNCTION IF EXISTS guard_data_access_policy_operation_delete();
DROP TRIGGER IF EXISTS druvia_data_access_policy_operations_protect_update
  ON druvia_data_access_policy_operations;
DROP FUNCTION IF EXISTS protect_data_access_policy_operation_update();
DROP TABLE druvia_data_access_policy_operations;
DROP TABLE druvia_data_access_managed_policies;

COMMIT;
