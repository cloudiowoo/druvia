BEGIN;

CREATE TABLE IF NOT EXISTS druvia_project_runtime_context_fences (
  project_id VARCHAR(64) PRIMARY KEY,
  first_enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO druvia_project_runtime_context_fences (project_id, first_enabled_at)
SELECT project_id, created_at
FROM druvia_project_runtime_contexts
ON CONFLICT (project_id) DO NOTHING;

COMMIT;
