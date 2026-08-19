ALTER TABLE druvia_storage_buckets
  ADD COLUMN project_user_access VARCHAR(32) NOT NULL DEFAULT 'admin_only';

ALTER TABLE druvia_storage_objects
  ADD COLUMN owner_project_user_id TEXT;

DO $$
DECLARE
  invalid_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO invalid_count
  FROM druvia_storage_objects
  WHERE name = ''
     OR name LIKE '/%'
     OR name LIKE '%/'
     OR name LIKE '%//%'
     OR POSITION(E'\\' IN name) > 0
     OR name ~ '(^|/)\.{1,2}(/|$)'
     OR name ~ '[[:cntrl:]]'
     OR name <> normalize(name, NFC);

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'invalid storage object names prevent migration 020: % row(s)', invalid_count;
  END IF;
END
$$;

ALTER TABLE druvia_storage_buckets
  ADD CONSTRAINT druvia_storage_buckets_project_user_access_check
  CHECK (project_user_access IN ('admin_only', 'owner_only', 'authenticated_read'));

ALTER TABLE druvia_storage_objects
  ADD CONSTRAINT druvia_storage_objects_canonical_name_check
  CHECK (
    name <> ''
    AND name NOT LIKE '/%'
    AND name NOT LIKE '%/'
    AND name NOT LIKE '%//%'
    AND POSITION(E'\\' IN name) = 0
    AND name !~ '(^|/)\.{1,2}(/|$)'
    AND name !~ '[[:cntrl:]]'
    AND name = normalize(name, NFC)
  );

UPDATE druvia_storage_objects
SET owner_project_user_id = metadata->>'created_by_project_user_id'
WHERE metadata->>'created_by_type' IN ('project_user', 'trusted_backend_project_user')
  AND jsonb_typeof(metadata->'created_by_project_user_id') = 'string'
  AND btrim(metadata->>'created_by_project_user_id') <> '';

CREATE INDEX idx_storage_objects_bucket_owner_name
  ON druvia_storage_objects (bucket_id, owner_project_user_id, name varchar_pattern_ops);
