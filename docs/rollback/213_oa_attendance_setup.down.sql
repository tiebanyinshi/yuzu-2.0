-- 回滚 213_oa_attendance_setup.sql（OA-04 考勤组、班次、打卡点）：删这几张表、撤掉 hr.attendance 的建议权限。
-- 已经授给岗位的 hr.attendance 留着不动（代码回滚后这一项不再认）。
BEGIN;
DROP TABLE IF EXISTS oa_group_members;
DROP TABLE IF EXISTS oa_group_locations;
DROP TABLE IF EXISTS oa_attendance_groups;
DROP TABLE IF EXISTS oa_locations;
DROP TABLE IF EXISTS oa_shifts;
DELETE FROM position_suggestions WHERE permission = 'hr.attendance';
DELETE FROM schema_migrations WHERE version = '213_oa_attendance_setup.sql';
COMMIT;
