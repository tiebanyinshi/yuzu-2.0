-- 回滚 490_material_images.sql（8.1.48 采购商城商品图）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 图片本身在 erp_images 里（只追加），不删；只删掉物料与图片的对应关系。
BEGIN;
DROP TABLE material_images;
DELETE FROM schema_migrations WHERE version = '490_material_images.sql';
COMMIT;
