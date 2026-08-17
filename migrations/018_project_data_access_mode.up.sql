ALTER TABLE druvia_projects
  ADD COLUMN data_access_mode VARCHAR(20) NOT NULL DEFAULT 'compatibility';

ALTER TABLE druvia_projects
  ADD CONSTRAINT druvia_projects_data_access_mode_check
  CHECK (data_access_mode IN ('compatibility', 'explicit'));
