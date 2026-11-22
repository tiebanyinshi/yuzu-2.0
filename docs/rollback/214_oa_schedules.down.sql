-- 回滚 214_oa_schedules.sql（OA-05 排班）：删排班表、撤掉 hr.attendanceDept 的建议权限。
-- 已经授给岗位的 hr.attendanceDept 留着不动（代码回滚后这一项不再认）。
BEGIN;
DROP TABLE IF EXISTS oa_schedules;
DELETE FROM position_suggestions WHERE permission = 'hr.attendanceDept';
DELETE FROM schema_migrations WHERE version = '214_oa_schedules.sql';
COMMIT;
