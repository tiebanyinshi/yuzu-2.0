-- 回滚 482_store_fks.sql（数据库评估：补门店外键）。只删约束，不动数据。
BEGIN;
ALTER TABLE price_catalog_sets DROP CONSTRAINT IF EXISTS price_catalog_sets_store_id_fkey;
ALTER TABLE price_catalog_import_ops DROP CONSTRAINT IF EXISTS price_catalog_import_ops_store_id_fkey;
ALTER TABLE price_catalog_set_ops DROP CONSTRAINT IF EXISTS price_catalog_set_ops_store_id_fkey;
ALTER TABLE price_catalog_links DROP CONSTRAINT IF EXISTS price_catalog_links_store_id_fkey;
ALTER TABLE price_catalog_link_ops DROP CONSTRAINT IF EXISTS price_catalog_link_ops_store_id_fkey;
ALTER TABLE room_orders DROP CONSTRAINT IF EXISTS room_orders_store_id_fkey;
ALTER TABLE room_order_outlets DROP CONSTRAINT IF EXISTS room_order_outlets_store_id_fkey;
ALTER TABLE table_events DROP CONSTRAINT IF EXISTS table_events_store_id_fkey;
DELETE FROM schema_migrations WHERE version = '482_store_fks.sql';
COMMIT;
