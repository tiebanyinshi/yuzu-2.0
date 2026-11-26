-- 回滚 291_oa_schedule_publish.sql（员工办公 v1.1 第 2 批：排班发布）。先停服务、先备份；只在回退到第 2 批以前时执行。
-- 删掉尚未发布的草稿行，恢复已发布行上的原状态，去掉发布状态列与发布记录表；操作类型约束留着不影响旧版。
BEGIN;
DELETE FROM oa_schedules WHERE status = 'draft';
DROP INDEX IF EXISTS oa_schedules_store_unpublished_idx;
ALTER TABLE oa_schedules
  DROP CONSTRAINT IF EXISTS oa_schedules_draft_state_check,
  DROP COLUMN IF EXISTS publish_id,
  DROP COLUMN IF EXISTS published_by,
  DROP COLUMN IF EXISTS published_at,
  DROP COLUMN IF EXISTS draft_consecutive,
  DROP COLUMN IF EXISTS pending_delete,
  DROP COLUMN IF EXISTS status;
DROP TABLE IF EXISTS oa_schedule_publishes;
DELETE FROM schema_migrations WHERE version = '291_oa_schedule_publish.sql';
COMMIT;
