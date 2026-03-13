-- 009_edge_functions.down.sql
BEGIN;
DROP TABLE IF EXISTS druvia_function_logs CASCADE;
DROP TABLE IF EXISTS druvia_function_schedules CASCADE;
DROP TABLE IF EXISTS druvia_function_secrets CASCADE;
DROP TABLE IF EXISTS druvia_functions CASCADE;
DROP FUNCTION IF EXISTS update_updated_at_column();
COMMIT;
