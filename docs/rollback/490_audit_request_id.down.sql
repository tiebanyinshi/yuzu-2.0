-- 回滚 490_audit_request_id.sql（后端评估：审计记录的请求编号）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 删掉这一列会丢掉已记下的请求编号（只是排查用的线索，业务数据不受影响）。
BEGIN;
ALTER TABLE audit_logs DROP COLUMN request_id;
DELETE FROM schema_migrations WHERE version = '490_audit_request_id.sql';
COMMIT;
