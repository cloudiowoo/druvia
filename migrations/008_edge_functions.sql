-- Edge Functions 数据库迁移
-- 支持 Deno Worker 执行自定义函数

BEGIN;

-- 1. 函数定义表
CREATE TABLE IF NOT EXISTS druvia_functions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR(64) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  code TEXT NOT NULL,
  runtime VARCHAR(50) DEFAULT 'deno',
  status VARCHAR(50) DEFAULT 'active',
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, name)
);

-- 2. 函数 Secrets 表（加密存储）
CREATE TABLE IF NOT EXISTS druvia_function_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR(64) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, key)
);

-- 3. 定时任务表
CREATE TABLE IF NOT EXISTS druvia_function_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id UUID NOT NULL REFERENCES druvia_functions(id) ON DELETE CASCADE,
  cron_expression VARCHAR(100) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. 函数执行日志表
CREATE TABLE IF NOT EXISTS druvia_function_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id UUID NOT NULL REFERENCES druvia_functions(id) ON DELETE CASCADE,
  execution_id UUID NOT NULL,
  level VARCHAR(20) DEFAULT 'info',
  message TEXT,
  duration_ms INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. 创建索引
CREATE INDEX IF NOT EXISTS idx_functions_project ON druvia_functions(project_id);
CREATE INDEX IF NOT EXISTS idx_functions_status ON druvia_functions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_function_secrets_project ON druvia_function_secrets(project_id);
CREATE INDEX IF NOT EXISTS idx_function_schedules_function ON druvia_function_schedules(function_id);
CREATE INDEX IF NOT EXISTS idx_function_schedules_next_run ON druvia_function_schedules(next_run_at) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_function_logs_function ON druvia_function_logs(function_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_function_logs_execution ON druvia_function_logs(execution_id);

-- 6. 更新触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_druvia_functions_updated_at') THEN
        CREATE TRIGGER update_druvia_functions_updated_at
            BEFORE UPDATE ON druvia_functions
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_druvia_function_secrets_updated_at') THEN
        CREATE TRIGGER update_druvia_function_secrets_updated_at
            BEFORE UPDATE ON druvia_function_secrets
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_druvia_function_schedules_updated_at') THEN
        CREATE TRIGGER update_druvia_function_schedules_updated_at
            BEFORE UPDATE ON druvia_function_schedules
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;
END
$$;

COMMIT;
