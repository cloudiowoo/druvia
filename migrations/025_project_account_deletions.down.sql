BEGIN;

LOCK TABLE druvia_project_account_deletions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE druvia_project_account_deletion_provider_tokens IN ACCESS EXCLUSIVE MODE;
LOCK TABLE druvia_project_runtime_gates IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM druvia_project_account_deletions
    WHERE status IN ('accepted', 'processing', 'attention_required', 'completed')
  ) OR EXISTS (
    SELECT 1 FROM druvia_project_account_deletion_provider_tokens LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM druvia_project_runtime_gates LIMIT 1
  ) THEN
    RAISE EXCEPTION 'cannot roll back migration 025 while project account deletion state exists'
      USING ERRCODE = '55006';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS guard_project_account_deletion_transition
  ON druvia_project_account_deletions;
DROP FUNCTION IF EXISTS guard_project_account_deletion_transition();
DROP TABLE druvia_account_deletion_executor_heartbeats;
DROP TABLE druvia_project_runtime_gates;
DROP TABLE druvia_project_account_deletion_provider_tokens;
DROP TABLE druvia_project_account_deletion_fences;
DROP TABLE druvia_project_account_deletions;
DROP TABLE druvia_project_account_deletion_configs;

ALTER TABLE druvia_project_auth_identities
  DROP COLUMN generation;

COMMIT;
