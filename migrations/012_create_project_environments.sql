-- migrations/012_create_project_environments.sql
-- Project environments for dev/prod isolation

CREATE TABLE IF NOT EXISTS druvia_project_environments (
  id SERIAL PRIMARY KEY,
  project_id VARCHAR(50) NOT NULL REFERENCES "public"."druvia_projects"("project_id") ON DELETE CASCADE,
  env_name VARCHAR(20) NOT NULL,
  schema_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, env_name)
);

CREATE INDEX idx_project_environments_project ON druvia_project_environments(project_id);

-- Insert prod environment for existing projects
INSERT INTO druvia_project_environments (project_id, env_name, schema_name)
SELECT project_id, 'prod', schema_name
FROM druvia_projects
ON CONFLICT DO NOTHING;
