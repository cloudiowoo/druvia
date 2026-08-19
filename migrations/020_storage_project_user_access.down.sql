DROP INDEX IF EXISTS idx_storage_objects_bucket_owner_name;

ALTER TABLE druvia_storage_objects
  DROP CONSTRAINT IF EXISTS druvia_storage_objects_canonical_name_check,
  DROP COLUMN owner_project_user_id;

ALTER TABLE druvia_storage_buckets
  DROP CONSTRAINT IF EXISTS druvia_storage_buckets_project_user_access_check,
  DROP COLUMN project_user_access;
