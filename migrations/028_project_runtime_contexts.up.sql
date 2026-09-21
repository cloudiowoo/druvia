BEGIN;

CREATE TABLE druvia_project_runtime_contexts (
  project_id VARCHAR(64) PRIMARY KEY
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  service_environment VARCHAR(16) NOT NULL
    CHECK (service_environment IN ('local', 'sandbox', 'testflight', 'production')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by VARCHAR(64)
    REFERENCES druvia_users(user_id) ON DELETE SET NULL,
  updated_by VARCHAR(64)
    REFERENCES druvia_users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE druvia_project_runtime_context_fences (
  project_id VARCHAR(64) PRIMARY KEY,
  first_enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION touch_project_runtime_context_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER druvia_project_runtime_contexts_touch_updated_at
BEFORE UPDATE ON druvia_project_runtime_contexts
FOR EACH ROW EXECUTE FUNCTION touch_project_runtime_context_updated_at();

COMMIT;
