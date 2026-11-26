-- 回滚 483_archive_tables.sql（数据库评估：热表归档）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 已归档的记录先原样挪回原表（编号不变；先事件后轨迹段，轨迹段引用事件），再删归档表，触发器换回 035 / 001 时的写法。
BEGIN;
INSERT INTO location_events (id, visit_id, technician_id, tag_code, kind, floor_id, zone_id, space_id, source, ref_type, ref_id, reader_id, at, recorded_at, applied, op_key, op_hash, x_mm, y_mm, accuracy_mm, device_id, staff_id) OVERRIDING SYSTEM VALUE SELECT id, visit_id, technician_id, tag_code, kind, floor_id, zone_id, space_id, source, ref_type, ref_id, reader_id, at, recorded_at, applied, op_key, op_hash, x_mm, y_mm, accuracy_mm, device_id, staff_id FROM archived_location_events ORDER BY id;
INSERT INTO location_tracks (id, visit_id, technician_id, floor_id, zone_id, space_id, entered_at, first_event_id, last_at, last_event_id, event_count, left_at, end_event_id) OVERRIDING SYSTEM VALUE SELECT id, visit_id, technician_id, floor_id, zone_id, space_id, entered_at, first_event_id, last_at, last_event_id, event_count, left_at, end_event_id FROM archived_location_tracks ORDER BY id;
INSERT INTO integration_calls (id, kind, provider, action, mode, ref_type, ref_id, request_summary, ok, result_summary, error, duration_ms, staff_id, created_at) OVERRIDING SYSTEM VALUE SELECT id, kind, provider, action, mode, ref_type, ref_id, request_summary, ok, result_summary, error, duration_ms, staff_id, created_at FROM archived_integration_calls ORDER BY id;
INSERT INTO wecom_pushes (id, kind, period_key, status, content, error, attempts, claimed_until, created_by, created_at, finished_at) OVERRIDING SYSTEM VALUE SELECT id, kind, period_key, status, content, error, attempts, claimed_until, created_by, created_at, finished_at FROM archived_wecom_pushes ORDER BY id;
DROP TABLE archived_location_events, archived_location_tracks, archived_integration_calls, archived_wecom_pushes;

DROP TRIGGER location_tracks_no_delete ON location_tracks;
DROP TRIGGER location_tracks_guard ON location_tracks;
CREATE TRIGGER location_tracks_guard BEFORE UPDATE OR DELETE ON location_tracks
  FOR EACH ROW EXECUTE FUNCTION yuzu_location_track_guard();
DROP TRIGGER integration_calls_append_only ON integration_calls;
CREATE TRIGGER integration_calls_append_only BEFORE UPDATE OR DELETE ON integration_calls
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
DROP TRIGGER location_events_append_only ON location_events;
CREATE TRIGGER location_events_append_only BEFORE UPDATE OR DELETE ON location_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
DROP FUNCTION yuzu_forbid_mutation_unless_archiving();
DELETE FROM schema_migrations WHERE version = '483_archive_tables.sql';
COMMIT;
