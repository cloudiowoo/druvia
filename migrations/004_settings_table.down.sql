-- 004_settings_table.down.sql
DROP TRIGGER IF EXISTS druvia_settings_updated_at ON druvia_settings;
DROP TABLE IF EXISTS druvia_settings;
