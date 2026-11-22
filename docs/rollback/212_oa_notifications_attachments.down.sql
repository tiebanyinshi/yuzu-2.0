-- 回滚 212_oa_notifications_attachments.sql（OA-03 站内通知与附件）。先停服务、先备份；只在回到 OA-03 以前的版本时执行。
-- 删掉站内通知与附件两张表：员工收到的通知、上传的附件都会丢（回滚前按需导出）。
BEGIN;
DROP TABLE IF EXISTS oa_attachments;
DROP TABLE IF EXISTS oa_notifications;
DELETE FROM schema_migrations WHERE version = '212_oa_notifications_attachments.sql';
COMMIT;
