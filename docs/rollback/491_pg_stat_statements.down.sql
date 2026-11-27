-- 回滚 491_pg_stat_statements.sql（数据库评估：查询统计扩展）。只删统计用的扩展，不动业务数据。
BEGIN;
DROP EXTENSION IF EXISTS pg_stat_statements;
DELETE FROM schema_migrations WHERE version = '491_pg_stat_statements.sql';
COMMIT;
