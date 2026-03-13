-- Storage 重构迁移脚本
-- 采用 S3 模型：Buckets + Objects 分离
-- 不迁移旧数据（druvia_files 为测试数据）

BEGIN;

-- 1. 创建存储桶表
CREATE TABLE IF NOT EXISTS druvia_storage_buckets (
  id SERIAL PRIMARY KEY,
  bucket_id VARCHAR(64) UNIQUE NOT NULL,
  project_id VARCHAR(64) NOT NULL REFERENCES druvia_projects(project_id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  public BOOLEAN DEFAULT false,
  file_size_limit BIGINT,
  allowed_mime_types TEXT[],
  cors_config JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, name)
);

-- 2. 创建存储对象表
CREATE TABLE IF NOT EXISTS druvia_storage_objects (
  id SERIAL PRIMARY KEY,
  object_id VARCHAR(64) UNIQUE NOT NULL,
  bucket_id VARCHAR(64) NOT NULL REFERENCES druvia_storage_buckets(bucket_id) ON DELETE CASCADE,
  name VARCHAR(1024) NOT NULL,
  size BIGINT NOT NULL,
  mime_type VARCHAR(255),
  etag VARCHAR(255),
  storage_provider VARCHAR(50),
  storage_path VARCHAR(1024),
  metadata JSONB DEFAULT '{}',
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bucket_id, name)
);

-- 3. 创建索引
CREATE INDEX IF NOT EXISTS idx_storage_buckets_project ON druvia_storage_buckets(project_id);
CREATE INDEX IF NOT EXISTS idx_storage_objects_bucket ON druvia_storage_objects(bucket_id);
CREATE INDEX IF NOT EXISTS idx_storage_objects_created ON druvia_storage_objects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_storage_objects_name ON druvia_storage_objects(name);

-- 4. 创建触发器
CREATE TRIGGER druvia_storage_buckets_updated_at
  BEFORE UPDATE ON druvia_storage_buckets
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

CREATE TRIGGER druvia_storage_objects_updated_at
  BEFORE UPDATE ON druvia_storage_objects
  FOR EACH ROW EXECUTE FUNCTION druvia_update_updated_at();

COMMIT;
