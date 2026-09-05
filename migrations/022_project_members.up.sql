BEGIN;

CREATE TABLE druvia_project_members (
  id BIGSERIAL PRIMARY KEY,
  project_id VARCHAR(64) NOT NULL
    REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  user_uid INTEGER NOT NULL
    REFERENCES druvia_users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL,
  created_by INTEGER
    REFERENCES druvia_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT druvia_project_members_role_check
    CHECK (role IN ('project_admin', 'database_admin', 'viewer')),
  CONSTRAINT druvia_project_members_project_user_key
    UNIQUE (project_id, user_uid)
);

CREATE INDEX idx_druvia_project_members_user
  ON druvia_project_members (user_uid, project_id);

CREATE TRIGGER druvia_project_members_updated_at
  BEFORE UPDATE ON druvia_project_members
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

COMMIT;
