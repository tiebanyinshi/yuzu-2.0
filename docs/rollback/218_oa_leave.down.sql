-- 回滚 218_oa_leave.sql（OA-09 假期余额）：删假期明细、余额与假种三张表。操作编号与确认作废的类型约束里多出的 oa_leave_adjust 留着（不影响旧代码）。
BEGIN;
DROP TABLE IF EXISTS oa_leave_entries;
DROP TABLE IF EXISTS oa_leave_balances;
DROP TABLE IF EXISTS oa_leave_types;
DELETE FROM schema_migrations WHERE version = '218_oa_leave.sql';
COMMIT;
