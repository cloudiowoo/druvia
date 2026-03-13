-- migrations/000_schema_versions.up.sql
CREATE TABLE IF NOT EXISTS druvia_schema_versions (
  version INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
