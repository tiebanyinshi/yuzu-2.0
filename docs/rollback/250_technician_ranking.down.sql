-- 回滚 250_technician_ranking.sql。先停服务、先备份。
-- 技师上挂的照片与照片本身一起删掉（不影响名册的其他资料、钟房与账单）。
BEGIN;
ALTER TABLE technicians DROP COLUMN IF EXISTS photo_id;
DROP TABLE IF EXISTS technician_photos;
DELETE FROM schema_migrations WHERE version = '250_technician_ranking.sql';
COMMIT;
