BEGIN;

CREATE TABLE druvia_table_deletion_outbox (
  operation_id VARCHAR(64) PRIMARY KEY,
  lock_scope VARCHAR(200) NOT NULL,
  schema_name VARCHAR(128) NOT NULL,
  table_name VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status = 'pending'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (schema_name, table_name)
);

CREATE INDEX idx_druvia_table_deletion_outbox_scope
  ON druvia_table_deletion_outbox(lock_scope, created_at);

CREATE OR REPLACE FUNCTION guard_pending_table_deletion_relation_reuse()
RETURNS event_trigger AS $$
DECLARE
  reserved_schema TEXT;
  reserved_name TEXT;
BEGIN
  SELECT namespace.nspname, relation.relname
  INTO reserved_schema, reserved_name
  FROM pg_event_trigger_ddl_commands() AS command
  JOIN pg_class AS relation
    ON command.classid = 'pg_class'::regclass
   AND relation.oid = command.objid
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN public.druvia_table_deletion_outbox AS pending
    ON pending.schema_name = namespace.nspname
   AND pending.table_name = relation.relname
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Relation %.% is reserved by pending table deletion recovery',
      reserved_schema, reserved_name
      USING ERRCODE = '55006',
            CONSTRAINT = 'druvia_table_deletion_outbox_relation_reuse_guard';
  END IF;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

CREATE EVENT TRIGGER druvia_guard_pending_table_deletion_relation_reuse
ON ddl_command_end
EXECUTE FUNCTION guard_pending_table_deletion_relation_reuse();

COMMIT;
