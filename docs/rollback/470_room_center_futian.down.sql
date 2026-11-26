-- 回滚 470_room_center_futian.sql（福田店整改批次 2）。先停服务、先备份；只在回到这一批以前的版本时执行。
-- 撤房、补单的登记单与新几种房间事件旧版本不认：先删掉这些房间事件、把撤房 / 补单的登记单改记成「退房」，再收回约束。
BEGIN;
-- 房间事件只追加（有守卫触发器）：回滚时临时关掉守卫删这几种，删完马上开回来
ALTER TABLE space_room_events DISABLE TRIGGER space_room_events_append_only;
DELETE FROM space_room_events WHERE kind IN ('revoke', 'backfill', 'room_fee');
ALTER TABLE space_room_events ENABLE TRIGGER space_room_events_append_only;
UPDATE room_registrations SET close_kind = 'checkout' WHERE close_kind IN ('revoked', 'backfill');
ALTER TABLE space_room_events DROP CONSTRAINT space_room_events_kind_check;
ALTER TABLE space_room_events ADD CONSTRAINT space_room_events_kind_check
  CHECK (kind IN ('register', 'move_out', 'move_in', 'checkout', 'extend', 'merge', 'unmerge', 'dirty', 'cleaned', 'maintenance', 'restore'));
ALTER TABLE room_registrations DROP CONSTRAINT room_registrations_close_kind_check;
ALTER TABLE room_registrations ADD CONSTRAINT room_registrations_close_kind_check CHECK (close_kind IN ('checkout', 'settled', 'visit_cancel'));
ALTER TABLE room_registrations DROP COLUMN kind;
ALTER TABLE technician_sessions DROP COLUMN room_neutral;
DELETE FROM schema_migrations WHERE version = '470_room_center_futian.sql';
COMMIT;
