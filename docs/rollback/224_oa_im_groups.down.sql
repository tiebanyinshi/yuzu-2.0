-- 回滚 224_oa_im_groups.sql（OA-16 通讯录与群管理）：去掉部门群同步触发器与函数、部门群 / 群公告 / 解散、进群方式。
-- 已经解散的群回滚后又能发消息（解散时间随列删掉）；部门群变成普通群。回滚前先备份（docs/COMMANDS.md「备份与回滚」）。
BEGIN;
DROP TRIGGER IF EXISTS oa_im_staff_sync_ins ON staff;
DROP TRIGGER IF EXISTS oa_im_staff_sync_upd ON staff;
DROP TRIGGER IF EXISTS oa_im_profile_sync ON staff_profiles;
DROP FUNCTION IF EXISTS oa_im_staff_sync_trg();
DROP FUNCTION IF EXISTS oa_im_profile_sync_trg();
DROP FUNCTION IF EXISTS oa_im_sync_staff(bigint);
DROP FUNCTION IF EXISTS oa_im_system_message(bigint, bigint, text);
ALTER TABLE oa_im_members DROP COLUMN IF EXISTS source;
DROP INDEX IF EXISTS oa_im_conversations_dept_uq;
ALTER TABLE oa_im_conversations DROP CONSTRAINT IF EXISTS oa_im_conversations_dept_group,
  DROP COLUMN IF EXISTS dept_key, DROP COLUMN IF EXISTS notice, DROP COLUMN IF EXISTS notice_by,
  DROP COLUMN IF EXISTS notice_at, DROP COLUMN IF EXISTS dissolved_at;
DELETE FROM settings WHERE key = 'oa_directory_phone';
DELETE FROM schema_migrations WHERE version = '224_oa_im_groups.sql';
COMMIT;
