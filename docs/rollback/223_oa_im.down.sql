-- 回滚 223_oa_im.sql（OA-14 即时通讯）：删会话、成员、消息三张表。聊天记录随之删掉，回滚前先备份（docs/COMMANDS.md「备份与回滚」）；
-- 挂在消息上的附件（oa_attachments.ref_type = 'oa_im_message'）留着，没有页面能再打开。
BEGIN;
ALTER TABLE IF EXISTS oa_im_conversations DROP CONSTRAINT IF EXISTS oa_im_conversations_last_fk;
DROP TABLE IF EXISTS oa_im_messages;
DROP TABLE IF EXISTS oa_im_members;
DROP TABLE IF EXISTS oa_im_conversations;
DELETE FROM schema_migrations WHERE version = '223_oa_im.sql';
COMMIT;
