-- 回滚 270_training.sql（员工培训第一期）。先停服务、先备份（培训文件的内容也在这几张表里，回滚就删掉了）。
BEGIN;
DROP TABLE IF EXISTS training_views;
DROP TABLE IF EXISTS training_upload_chunks;
DROP TABLE IF EXISTS training_uploads;
ALTER TABLE IF EXISTS training_files DROP CONSTRAINT IF EXISTS training_files_current_fk;
DROP TABLE IF EXISTS training_file_versions;
DROP TABLE IF EXISTS training_files;
DROP TABLE IF EXISTS training_blob_chunks;
DROP TABLE IF EXISTS training_blobs;
DROP TABLE IF EXISTS training_folders;
DELETE FROM position_suggestions WHERE permission = 'training.manage';
DELETE FROM schema_migrations WHERE version = '270_training.sql';
COMMIT;
