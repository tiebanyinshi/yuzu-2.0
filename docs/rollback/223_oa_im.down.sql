-- 回滚 223_oa_im.sql（OA-14 即时通讯）：删会话、成员、消息三张表。聊天记录随之删掉，回滚前先备份（docs/COMMANDS.md「备份与回滚」）；
-- 挂在消息上的附件（oa_attachments.ref_type = 'oa_im_message'）留着，没有页面能再打开。
BEGIN;
-- op_fences、idempotency_keys 只追加（001、006 的触发器）：维护性删除时临时关掉对应的触发器，删完马上恢复（不然有记录的库上回滚会整笔失败）
ALTER TABLE IF EXISTS oa_im_conversations DROP CONSTRAINT IF EXISTS oa_im_conversations_last_fk;
DROP TABLE IF EXISTS oa_im_messages;
DROP TABLE IF EXISTS oa_im_members;
DROP TABLE IF EXISTS oa_im_conversations;
-- 操作编号与确认作废的类型约束里的 oa_im_group 留着（多一个类型不影响别的；先删掉这一类的记录也行）
ALTER TABLE idempotency_keys DISABLE TRIGGER idempotency_keys_append_only;
DELETE FROM idempotency_keys WHERE op_type = 'oa_im_group';
ALTER TABLE idempotency_keys ENABLE TRIGGER idempotency_keys_append_only;
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type = 'oa_im_group';
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
DELETE FROM schema_migrations WHERE version = '223_oa_im.sql';
COMMIT;
