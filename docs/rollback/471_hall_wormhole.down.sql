-- 回滚 471_hall_wormhole.sql（福田店整改批次 4）。先停服务、先备份；只在回到这一批以前的版本时执行。
-- 虫洞使用单与分区旧版本不认：删掉这两张表与空间上的分区列、新几种房间事件，再收回约束。虫洞的费用明细留在账单上（是正常的挂账）。
BEGIN;
ALTER TABLE space_room_events DISABLE TRIGGER space_room_events_append_only;
DELETE FROM space_room_events WHERE kind IN ('add_item', 'goods', 'wormhole_in', 'wormhole_out');
ALTER TABLE space_room_events ENABLE TRIGGER space_room_events_append_only;
ALTER TABLE space_room_events DROP CONSTRAINT space_room_events_kind_check;
ALTER TABLE space_room_events ADD CONSTRAINT space_room_events_kind_check
  CHECK (kind IN ('register', 'move_out', 'move_in', 'checkout', 'extend', 'merge', 'unmerge', 'dirty', 'cleaned', 'maintenance', 'restore',
                  'revoke', 'backfill', 'room_fee'));
DROP TABLE wormhole_stays;
DROP FUNCTION yuzu_wormhole_stay_guard();
ALTER TABLE spaces DROP COLUMN hall_zone_id;
DROP TABLE hall_zones;
DELETE FROM schema_migrations WHERE version = '471_hall_wormhole.sql';
COMMIT;
