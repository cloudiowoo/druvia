-- Add realtime_enabled column to all per-schema _meta_tables
-- _meta_tables exists in each tenant/project schema, so we must iterate

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT schema_name FROM druvia_schema_registry
  LOOP
    EXECUTE format(
      'ALTER TABLE %I._meta_tables ADD COLUMN IF NOT EXISTS realtime_enabled BOOLEAN NOT NULL DEFAULT false',
      r.schema_name
    );
  END LOOP;
END $$;
