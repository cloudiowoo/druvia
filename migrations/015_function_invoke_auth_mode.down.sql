BEGIN;

ALTER TABLE druvia_functions
  DROP CONSTRAINT IF EXISTS druvia_functions_invoke_auth_mode_check;

ALTER TABLE druvia_functions
  DROP COLUMN IF EXISTS invoke_auth_mode;

COMMIT;
