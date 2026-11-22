-- OA-06 打卡（docs/OA.md 第 9 节；需求文档四（四）、第十三节第 1、2 条）。
--   · oa_punches：打卡明细，只追加（不改不删）。每次打卡一行，按打卡时间匹配本人的排班：
--       kind = in / out：落在那条排班（员工 + business_date + shift_id）的上班 / 下班窗口里；
--       kind = outside：落在某条排班的打卡时段里、但不在两个窗口里（上班中途），只留明细；
--       kind = rest：不在任何排班的打卡时段里（休息日打卡，等 OA-13 与加班审批关联）。
--     business_date = 匹配到的排班日期（跨天班的下班卡也记在上班那天）；没匹配到排班的按打卡时门店所在地的日期。
--     有效卡不存：同一排班上班卡取第一次、下班卡取最后一次（查询时算）。late_minutes / early_minutes 是打卡当时按班次设置算的。
--     排班行会被保存排班删了重写（今天起、没打过卡的那一班），所以这里不引用排班行的 id，按员工 + 日期 + 班次对应。
--   · 位置：带定位就记经纬度、精度、最近的打卡点与距离；location_ok = 在组里某个打卡点范围内（组不要求 GPS 时为 true）。
--     外勤：outwork = true，写事由、挂一张照片（oa_attachments，ref_type = 'oa_punch'）。
--   · 防作弊：设备、IP；shared_location = 同一坐标一分钟内有别人也打了卡（只告警）。
-- 打卡带操作编号：操作编号与「确认作废」多一类 oa_punch（在当时的约束上追加）。
-- 回滚：docs/rollback/215_oa_punches.down.sql（删这张表）。

CREATE TABLE oa_punches (
  id              bigserial PRIMARY KEY,
  store_id        bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  staff_id        bigint NOT NULL REFERENCES staff (id),
  punched_at      timestamptz NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('in', 'out', 'outside', 'rest')),
  business_date   date NOT NULL,
  shift_id        bigint REFERENCES oa_shifts (id),
  late_minutes    integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_minutes   integer NOT NULL DEFAULT 0 CHECK (early_minutes >= 0),
  group_id        bigint REFERENCES oa_attendance_groups (id),
  lat             numeric(9, 6) CHECK (lat BETWEEN -90 AND 90),
  lng             numeric(9, 6) CHECK (lng BETWEEN -180 AND 180),
  accuracy_m      integer CHECK (accuracy_m >= 0),
  location_id     bigint REFERENCES oa_locations (id),
  distance_m      integer CHECK (distance_m >= 0),
  location_ok     boolean NOT NULL,
  outwork         boolean NOT NULL DEFAULT false,
  outwork_reason  text CHECK (outwork_reason IS NULL OR char_length(outwork_reason) BETWEEN 1 AND 200),
  shared_location boolean NOT NULL DEFAULT false,
  device_info     text NOT NULL DEFAULT '' CHECK (char_length(device_info) <= 400),
  ip              text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('in', 'out')) = (shift_id IS NOT NULL)),
  CHECK (NOT outwork OR (outwork_reason IS NOT NULL AND lat IS NOT NULL))
);
CREATE INDEX oa_punches_staff_time_idx ON oa_punches (staff_id, punched_at);
CREATE INDEX oa_punches_slot_idx ON oa_punches (staff_id, business_date, shift_id, kind);
CREATE INDEX oa_punches_store_date_idx ON oa_punches (store_id, business_date);
CREATE INDEX oa_punches_store_time_idx ON oa_punches (store_id, punched_at);

DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''oa_punch''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
