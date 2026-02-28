-- migrations/004_settings_table.sql
-- Platform settings table

CREATE TABLE IF NOT EXISTS druvia_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger for updated_at
CREATE TRIGGER druvia_settings_updated_at
  BEFORE UPDATE ON druvia_settings
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

-- Initial settings
INSERT INTO druvia_settings (key, value) VALUES
  ('default_plan', '"free"'),
  ('default_storage_limit', '1073741824'),
  ('default_project_limit', '5'),
  ('default_user_limit', '10'),
  ('backup_retention_days', '30'),
  ('backup_max_count', '10')
ON CONFLICT (key) DO NOTHING;
