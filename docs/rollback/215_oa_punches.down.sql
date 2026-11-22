-- 回滚 215_oa_punches.sql（OA-06 打卡）：删打卡明细表。挂在打卡上的外勤照片（oa_attachments，ref_type = 'oa_punch'）一并删掉。
BEGIN;
DELETE FROM oa_attachments WHERE ref_type = 'oa_punch';
DROP TABLE IF EXISTS oa_punches;
DELETE FROM schema_migrations WHERE version = '215_oa_punches.sql';
COMMIT;
