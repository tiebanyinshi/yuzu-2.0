-- 回滚 265_design_assets.sql。先停服务、先备份；素材库里的文件会一起删掉，回滚前先从 Design → 素材库把要留的下载下来。
BEGIN;
DROP TABLE design_assign_fences;
DROP TABLE design_slot_assignments;
DROP TABLE design_asset_versions;
DROP TABLE design_assets;
DROP FUNCTION yuzu_design_append_only();
DELETE FROM schema_migrations WHERE version = '265_design_assets.sql';
COMMIT;
