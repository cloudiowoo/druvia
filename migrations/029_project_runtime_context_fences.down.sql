BEGIN;

SET LOCAL lock_timeout = '1s';
LOCK TABLE druvia_project_runtime_contexts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE druvia_project_runtime_context_fences IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM druvia_project_runtime_contexts)
     OR EXISTS (SELECT 1 FROM druvia_project_runtime_context_fences) THEN
    RAISE EXCEPTION 'cannot roll back migration 029 while project runtime context state exists'
      USING ERRCODE = '55006';
  END IF;
END;
$$;

COMMIT;
