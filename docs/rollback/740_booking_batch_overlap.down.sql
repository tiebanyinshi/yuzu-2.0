-- 回滚 740_booking_batch_overlap.sql（8.2.4 的一报多预约补「有意重叠」标记）。先停服务、先备份；只在回到这一份迁移以前的版本时执行。
-- 会回到：740 标上的那些预约（按它记的审计 booking_overlap_backfill 找）改回 false，前台自检又会把 8.2.4 一报多的重叠报出来。
-- 审计只追加，740 记的那几条留着（回滚以后再升级会再标一次、再记一次）。别的预约（8.2.5 起一报多建的）不动。
BEGIN;
UPDATE bookings SET technician_overlap = false
WHERE technician_overlap
  AND id IN (SELECT target_id::bigint FROM audit_logs WHERE action = 'booking_overlap_backfill' AND target_type = 'booking');
DROP FUNCTION IF EXISTS yuzu_booking_batch_links();
DROP FUNCTION IF EXISTS yuzu_booking_batch_row_key(uuid, integer);
DELETE FROM schema_migrations WHERE version = '740_booking_batch_overlap.sql';
COMMIT;
