-- 007_storage_redesign.down.sql
BEGIN;
DROP TRIGGER IF EXISTS druvia_storage_objects_updated_at ON druvia_storage_objects;
DROP TRIGGER IF EXISTS druvia_storage_buckets_updated_at ON druvia_storage_buckets;
DROP TABLE IF EXISTS druvia_storage_objects CASCADE;
DROP TABLE IF EXISTS druvia_storage_buckets CASCADE;
COMMIT;
