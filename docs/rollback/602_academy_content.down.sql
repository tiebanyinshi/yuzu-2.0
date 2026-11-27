-- 回滚 602_academy_content.sql（汤崎学堂第三批：课件与 AI）。先停服务、先备份（问柚子的问答记录会删掉；已经导入的课程、题目不在这两张表里，不受影响）。
BEGIN;
DROP TABLE IF EXISTS academy_tutor_questions;
DROP TABLE IF EXISTS academy_bulk_ops;
DELETE FROM schema_migrations WHERE version = '602_academy_content.sql';
COMMIT;
