BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM druvia_project_auth_identities)
    OR EXISTS (SELECT 1 FROM druvia_project_auth_provider_tokens)
    OR EXISTS (SELECT 1 FROM druvia_project_auth_events)
  THEN
    RAISE EXCEPTION 'cannot roll back migration 021 while project auth state exists'
      USING ERRCODE = '55006';
  END IF;
END
$$;

ALTER TABLE druvia_project_refresh_tokens
  DROP CONSTRAINT IF EXISTS druvia_project_refresh_tokens_apple_identity_check;

DROP INDEX IF EXISTS idx_project_refresh_tokens_identity;

ALTER TABLE druvia_project_refresh_tokens
  DROP COLUMN IF EXISTS provider_audience,
  DROP COLUMN IF EXISTS identity_id;

DROP TABLE druvia_project_auth_events;
DROP TABLE druvia_project_auth_provider_tokens;
DROP TABLE druvia_project_auth_identities;

COMMIT;
