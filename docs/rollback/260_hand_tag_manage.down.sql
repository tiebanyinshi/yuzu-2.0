-- 回滚 260_hand_tag_manage.sql。先停服务、先备份。
-- 去掉手牌柜的使用状态与删除标记：已删除的手牌本来就是停用的，回滚后在手牌池里显示为「停用」，前台照样发不出。
BEGIN;
ALTER TABLE hand_tags
  DROP CONSTRAINT IF EXISTS hand_tags_deleted_inactive,
  DROP COLUMN IF EXISTS deleted_by,
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS service_at,
  DROP COLUMN IF EXISTS service_by,
  DROP COLUMN IF EXISTS service_note,
  DROP COLUMN IF EXISTS service_status;
DELETE FROM schema_migrations WHERE version = '260_hand_tag_manage.sql';
COMMIT;
