BEGIN;

ALTER TABLE druvia_functions
  ADD COLUMN IF NOT EXISTS invoke_auth_mode VARCHAR(32);

UPDATE druvia_functions
SET invoke_auth_mode = 'jwt_required'
WHERE invoke_auth_mode IS NULL;

ALTER TABLE druvia_functions
  ALTER COLUMN invoke_auth_mode SET DEFAULT 'jwt_required';

ALTER TABLE druvia_functions
  ALTER COLUMN invoke_auth_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'druvia_functions_invoke_auth_mode_check'
  ) THEN
    ALTER TABLE druvia_functions
      ADD CONSTRAINT druvia_functions_invoke_auth_mode_check
      CHECK (invoke_auth_mode IN ('jwt_required', 'anon_allowed'));
  END IF;
END
$$;

UPDATE druvia_functions
SET invoke_auth_mode = 'anon_allowed'
WHERE name IN ('wx-silent-login', 'wx-login-register', 'wx-auth', 'wx-auth-fixed');

COMMIT;
