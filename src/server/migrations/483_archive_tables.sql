-- 数据库评估（8.1.47，docs/DB_REVIEW_V8147.md 第 5 节）：热表归档。
-- 原来只有附件、培训上传、过期登录有清理，其余表只增不减。只增不减、又只在近期有用的四张「流水型」表改为定期挪进归档表：
--   · 位置事件 location_events、轨迹段 location_tracks（每次刷卡、定位一条，量最大；历史轨迹只看近期）；
--   · 对外调用记录 integration_calls（每次调外部接口一条；后台只看最近 100 条）；
--   · 企业微信推送记录 wecom_pushes（已发完、已失败的）。
-- 归档表与原表同列、外加归档时刻 archived_at，放在 public 下、名字前加 archived_（不另建模式：备份核对的数据指纹、演示库重置都按 public 一个模式处理，
-- 归档表照样进备份与指纹）。归档表只追加（同 yuzu_forbid_mutation）。挪的工作由应用每小时做一次（src/server/modules/archive.ts），保留天数见环境变量
-- ARCHIVE_LOCATION_DAYS / ARCHIVE_INTEGRATION_CALL_DAYS / ARCHIVE_WECOM_PUSH_DAYS（默认 180 / 180 / 365，0 = 不归档）。
-- 账本、单据、审计日志一律不归档（只追加、永久保留）。
-- 原表只追加的保护照旧，只多一个口子：同一事务里 SET LOCAL yuzu.archiving = 'on' 时允许 DELETE（只有归档任务这么设；UPDATE 仍然一律拒绝）。
-- 位置轨迹段原来一个触发器管改和删，拆成两个：改照旧由 yuzu_location_track_guard 管，删由新函数管。
-- 风险已知：新建 4 张空表、换 3 个触发器（只追加的含义不变），不动已有数据；回滚见 docs/rollback/483_archive_tables.down.sql。

CREATE FUNCTION yuzu_forbid_mutation_unless_archiving() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('yuzu.archiving', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% 为只追加记录，禁止 %', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;

DROP TRIGGER location_events_append_only ON location_events;
CREATE TRIGGER location_events_append_only BEFORE UPDATE OR DELETE ON location_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation_unless_archiving();

DROP TRIGGER integration_calls_append_only ON integration_calls;
CREATE TRIGGER integration_calls_append_only BEFORE UPDATE OR DELETE ON integration_calls
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation_unless_archiving();

DROP TRIGGER location_tracks_guard ON location_tracks;
CREATE TRIGGER location_tracks_guard BEFORE UPDATE ON location_tracks
  FOR EACH ROW EXECUTE FUNCTION yuzu_location_track_guard();
CREATE TRIGGER location_tracks_no_delete BEFORE DELETE ON location_tracks
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation_unless_archiving();

-- 归档表：与原表同列（LIKE，不带约束、默认值与索引：编号沿用原来的），加归档时刻；主键仍是原编号
CREATE TABLE archived_location_events (LIKE location_events INCLUDING COMMENTS, archived_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (id));
CREATE INDEX archived_location_events_visit_idx ON archived_location_events (visit_id, at) WHERE visit_id IS NOT NULL;
CREATE INDEX archived_location_events_technician_idx ON archived_location_events (technician_id, at) WHERE technician_id IS NOT NULL;
CREATE TABLE archived_location_tracks (LIKE location_tracks INCLUDING COMMENTS, archived_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (id));
CREATE INDEX archived_location_tracks_visit_idx ON archived_location_tracks (visit_id, entered_at) WHERE visit_id IS NOT NULL;
CREATE INDEX archived_location_tracks_technician_idx ON archived_location_tracks (technician_id, entered_at) WHERE technician_id IS NOT NULL;
CREATE TABLE archived_integration_calls (LIKE integration_calls INCLUDING COMMENTS, archived_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (id));
CREATE INDEX archived_integration_calls_ref_idx ON archived_integration_calls (ref_type, ref_id);
CREATE TABLE archived_wecom_pushes (LIKE wecom_pushes INCLUDING COMMENTS, archived_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (id));

COMMENT ON TABLE archived_location_events IS '位置事件的归档：超过保留天数、已没有轨迹段与当前位置引用的事件，由归档任务从 location_events 挪来（只追加；建表：483_archive_tables）';
COMMENT ON TABLE archived_location_tracks IS '位置轨迹段的归档：结束超过保留天数、不是谁的当前段的，由归档任务从 location_tracks 挪来（只追加；建表：483_archive_tables）';
COMMENT ON TABLE archived_integration_calls IS '对外调用记录的归档：超过保留天数的，由归档任务从 integration_calls 挪来（只追加；建表：483_archive_tables）';
COMMENT ON TABLE archived_wecom_pushes IS '企业微信推送记录的归档：已发完或已失败、超过保留天数的，由归档任务从 wecom_pushes 挪来（只追加；建表：483_archive_tables）';
COMMENT ON COLUMN archived_location_events.archived_at IS '挪进归档的时刻';
COMMENT ON COLUMN archived_location_tracks.archived_at IS '挪进归档的时刻';
COMMENT ON COLUMN archived_integration_calls.archived_at IS '挪进归档的时刻';
COMMENT ON COLUMN archived_wecom_pushes.archived_at IS '挪进归档的时刻';

CREATE TRIGGER archived_location_events_append_only BEFORE UPDATE OR DELETE ON archived_location_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER archived_location_tracks_append_only BEFORE UPDATE OR DELETE ON archived_location_tracks
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER archived_integration_calls_append_only BEFORE UPDATE OR DELETE ON archived_integration_calls
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER archived_wecom_pushes_append_only BEFORE UPDATE OR DELETE ON archived_wecom_pushes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
