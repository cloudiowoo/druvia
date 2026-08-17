ALTER TABLE druvia_projects
  DROP CONSTRAINT druvia_projects_data_access_mode_check;

ALTER TABLE druvia_projects
  DROP COLUMN data_access_mode;
