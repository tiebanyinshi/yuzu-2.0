-- 回滚 217_oa_attendance_daily.sql（OA-08 考勤结算）：删每日考勤结果（可以由打卡明细重新算出来）。
BEGIN;
DROP TABLE IF EXISTS oa_attendance_daily;
DELETE FROM schema_migrations WHERE version = '217_oa_attendance_daily.sql';
COMMIT;
