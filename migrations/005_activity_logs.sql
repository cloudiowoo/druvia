-- migrations/005_activity_logs.sql
-- Activity logs table for dashboard

CREATE TABLE IF NOT EXISTS druvia_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(64) REFERENCES druvia_users(user_id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  target_type VARCHAR(50),
  target_id VARCHAR(100),
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at
ON druvia_activity_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id
ON druvia_activity_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_activity_logs_action
ON druvia_activity_logs(action);

COMMENT ON TABLE druvia_activity_logs IS 'Audit log for admin activities';
