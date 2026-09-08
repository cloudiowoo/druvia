BEGIN;

LOCK TABLE druvia_table_deletion_outbox IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM druvia_table_deletion_outbox LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot rollback while table deletion recovery is pending'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

DROP EVENT TRIGGER IF EXISTS druvia_guard_pending_table_deletion_relation_reuse;
DROP FUNCTION IF EXISTS guard_pending_table_deletion_relation_reuse();
DROP TABLE druvia_table_deletion_outbox;

COMMIT;
