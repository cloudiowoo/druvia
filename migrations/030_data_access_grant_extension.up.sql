BEGIN;

SET LOCAL lock_timeout = '5s';
LOCK TABLE druvia_data_access_policy_operations IN ACCESS EXCLUSIVE MODE;

ALTER TABLE druvia_data_access_policy_operations
  DROP CONSTRAINT druvia_data_access_policy_operations_kind_check;
ALTER TABLE druvia_data_access_policy_operations
  ADD CONSTRAINT druvia_data_access_policy_operations_kind_check
  CHECK (kind IN ('adoption', 'policy_update', 'reconcile', 'grant_extension'));

COMMIT;
