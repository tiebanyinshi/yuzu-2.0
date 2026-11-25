-- 回滚 311_table_min_spend.sql（8.1.39 桌台低消、服务费、转挂账、拼台）。先停服务、先备份；只在回到 8.1.39 以前的版本时执行。
-- 还有没结的挂账单、拼台的单时先结掉（旧版本不认识挂账与拼台，一张桌只能有一个没结的开台，重建索引会失败）。
-- 自动记的服务费、低消补足明细留着（金额都在明细上），只去掉标记。
BEGIN;
DROP INDEX table_sessions_parked_idx;
DROP INDEX table_sessions_table_open_uq;
CREATE UNIQUE INDEX table_sessions_table_open_uq ON table_sessions (table_id) WHERE status = 'open';
ALTER TABLE table_sessions DROP COLUMN shared;
ALTER TABLE table_sessions DROP CONSTRAINT table_sessions_parked_check;
ALTER TABLE table_sessions DROP COLUMN park_reason;
ALTER TABLE table_sessions DROP COLUMN parked_by;
ALTER TABLE table_sessions DROP COLUMN parked_at;
ALTER TABLE bill_lines DROP COLUMN charge_kind;
ALTER TABLE dining_tables DROP COLUMN service_fee_bp;
ALTER TABLE dining_tables DROP COLUMN min_spend;
DELETE FROM schema_migrations WHERE version = '311_table_min_spend.sql';
COMMIT;
