-- 回滚 222_oa_attendance_link.sql（OA-13 考勤与审批联动）：删考勤覆盖与节假日表，去掉补卡关联与每日结果的覆盖列。
-- 先把请假、出差的结果改回旷工以外的「异常」以便放回原来的约束（回滚以后重新结算一次即按旧规则算）；补卡写的打卡明细保留（只是不再标补卡）。
-- 请假扣减的余额明细保留（OA-09 的明细只追加），要退的由人事在「假种与余额」里调整。
BEGIN;
UPDATE oa_attendance_daily SET status = 'abnormal' WHERE status IN ('leave', 'trip');
ALTER TABLE oa_attendance_daily DROP COLUMN IF EXISTS cover_approval_id;
ALTER TABLE oa_attendance_daily DROP COLUMN IF EXISTS cover;
ALTER TABLE oa_attendance_daily DROP CONSTRAINT IF EXISTS oa_attendance_daily_status_check;
ALTER TABLE oa_attendance_daily ADD CONSTRAINT oa_attendance_daily_status_check CHECK (status IN ('normal', 'abnormal', 'absent'));
DROP INDEX IF EXISTS oa_punches_makeup_uq;
ALTER TABLE oa_punches DROP COLUMN IF EXISTS makeup_approval_id;
DROP TABLE IF EXISTS oa_holidays;
DROP TABLE IF EXISTS oa_holiday_years;
DROP TABLE IF EXISTS oa_attendance_covers;
DELETE FROM schema_migrations WHERE version = '222_oa_attendance_link.sql';
COMMIT;
