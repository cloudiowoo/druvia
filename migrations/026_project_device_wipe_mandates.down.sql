BEGIN;

LOCK TABLE druvia_project_device_wipe_mandates IN ACCESS EXCLUSIVE MODE;
LOCK TABLE druvia_project_device_wipe_bindings IN ACCESS EXCLUSIVE MODE;
LOCK TABLE druvia_project_device_wipe_signing_keys IN ACCESS EXCLUSIVE MODE;
LOCK TABLE druvia_project_device_wipe_configs IN ACCESS EXCLUSIVE MODE;

DO $device_wipe_rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM druvia_project_device_wipe_mandates)
    OR EXISTS (SELECT 1 FROM druvia_project_device_wipe_bindings)
    OR EXISTS (SELECT 1 FROM druvia_project_device_wipe_signing_keys)
    OR EXISTS (SELECT 1 FROM druvia_project_device_wipe_configs)
  THEN
    RAISE EXCEPTION 'cannot roll back migration 026 while project device wipe state exists'
      USING ERRCODE = '55006';
  END IF;
END
$device_wipe_rollback_guard$;

DROP TRIGGER guard_project_device_wipe_signing_key_retirement
  ON druvia_project_device_wipe_signing_keys;
DROP FUNCTION guard_project_device_wipe_signing_key_retirement();
DROP TRIGGER guard_project_device_wipe_mandate_transition
  ON druvia_project_device_wipe_mandates;
DROP FUNCTION guard_project_device_wipe_mandate_transition();
DROP TRIGGER guard_project_device_wipe_binding_transition
  ON druvia_project_device_wipe_bindings;
DROP FUNCTION guard_project_device_wipe_binding_transition();

DROP TABLE druvia_project_device_wipe_mandates;
DROP TABLE druvia_project_device_wipe_bindings;
DROP TABLE druvia_project_device_wipe_signing_keys;
DROP TABLE druvia_project_device_wipe_configs;

COMMIT;
