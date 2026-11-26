-- 回滚 292_oa_schedule_grants.sql（员工办公 v1.1 第 2 批：排班授权）。先停服务、先备份；只在回退到第 2 批以前时执行。
-- 删掉排班授权表；审计记录只追加保留，操作类型约束留着不影响旧版。
BEGIN;
DROP TABLE IF EXISTS oa_schedule_grants;
DELETE FROM schema_migrations WHERE version = '292_oa_schedule_grants.sql';
COMMIT;
