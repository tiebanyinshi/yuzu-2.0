-- 回滚 266_design_slot_store.sql。先停服务、先备份。
-- 分店设过的用途会和本店的混在一起（回到全公司一份，最新一行为准），回滚前先在各分店把用途切回「不用素材」，或接受以最后一次切换为准。
BEGIN;
DROP INDEX design_slot_assignments_store_slot_idx;
CREATE INDEX design_slot_assignments_slot_idx ON design_slot_assignments (slot, id DESC);
ALTER TABLE design_slot_assignments DROP COLUMN store_id;
ALTER TABLE design_assign_fences DROP COLUMN store_id;
DELETE FROM schema_migrations WHERE version = '266_design_slot_store.sql';
COMMIT;
