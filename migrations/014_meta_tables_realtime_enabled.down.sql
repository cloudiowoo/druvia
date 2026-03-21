DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT schema_name FROM druvia_schema_registry
  LOOP
    EXECUTE format(
      'ALTER TABLE %I._meta_tables DROP COLUMN IF EXISTS realtime_enabled',
      r.schema_name
    );
  END LOOP;
END $$;
