-- 006: 项目数据库凭证
-- 为每个项目创建独立的数据库用户，支持外部工具直连

-- 添加数据库凭证字段到项目表
ALTER TABLE druvia_projects
ADD COLUMN IF NOT EXISTS db_user VARCHAR(64),
ADD COLUMN IF NOT EXISTS db_password_hash VARCHAR(255),
ADD COLUMN IF NOT EXISTS db_created_at TIMESTAMP WITH TIME ZONE;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_druvia_projects_db_user ON druvia_projects(db_user);

-- 注释
COMMENT ON COLUMN druvia_projects.db_user IS '项目专属数据库用户名';
COMMENT ON COLUMN druvia_projects.db_password_hash IS '数据库密码哈希（bcrypt）';
COMMENT ON COLUMN druvia_projects.db_created_at IS '数据库用户创建时间';
