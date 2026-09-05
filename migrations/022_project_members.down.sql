BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM druvia_project_members LIMIT 1) THEN
    RAISE EXCEPTION 'cannot roll back migration 022 while project memberships exist'
      USING ERRCODE = '55006';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS druvia_project_members_updated_at
  ON druvia_project_members;
DROP TABLE druvia_project_members;

COMMIT;
