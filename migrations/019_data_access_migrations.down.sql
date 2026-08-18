DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM druvia_data_access_migrations
    WHERE status IN ('applying', 'rolling_back', 'applied')
       OR (
         status = 'failed'
         AND error_code IN (
           'DATA_ACCESS_MIGRATION_RECOVERY_REQUIRED',
           'DATA_ACCESS_ROLLBACK_RECOVERY_REQUIRED'
         )
       )
  ) THEN
    RAISE EXCEPTION 'cannot roll back migration 019 while recovery or rollback state exists'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

DROP TRIGGER guard_data_access_migration_delete ON druvia_data_access_migrations;
DROP TRIGGER protect_data_access_migration_update ON druvia_data_access_migrations;
DROP FUNCTION guard_data_access_migration_delete();
DROP FUNCTION protect_data_access_migration_update();
DROP TABLE druvia_data_access_migrations;
