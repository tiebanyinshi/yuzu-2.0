-- OA-04 考勤组、班次、打卡点（docs/OA.md 第 7 节；需求文档四（一）、四（二））。
--   · oa_shifts：班次（上下班时间按「当天第几分钟」存，下班不晚于上班 = 跨天班）与打卡窗口的几个时长（默认值 OA9）；
--   · oa_locations：打卡点（经纬度、有效半径）；
--   · oa_attendance_groups：考勤组（GPS / 人脸两个开关）；oa_group_locations：组用哪几个打卡点；oa_group_members：成员（一人一组）。
-- 都按门店分，不删只停用（排班、打卡记录会引用）；后台改的时候带版本。
-- 新权限项 hr.attendance（算「业务录入」那一列）：建议权限给总经办、人力行政部负责人与员工（与 src/shared/positions.ts 的 POSITION_DEFAULTS 一致）。
-- 新建班次、打卡点、考勤组带操作编号：操作编号与「确认作废」多一类 oa_attendance_setup（在当时的约束上追加）。
-- 回滚：docs/rollback/213_oa_attendance_setup.down.sql（删这几张表、撤掉建议权限）。

CREATE TABLE oa_shifts (
  id                   bigserial PRIMARY KEY,
  store_id             bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  name                 text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 20),
  start_minute         integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute           integer NOT NULL CHECK (end_minute BETWEEN 0 AND 1439),
  -- 休息段（可不填）：两个都有或都没有
  rest_start_minute    integer CHECK (rest_start_minute BETWEEN 0 AND 1439),
  rest_end_minute      integer CHECK (rest_end_minute BETWEEN 0 AND 1439),
  -- 打卡窗口（分钟）：上班卡可提前、迟到弹性、上班窗口在上班后再开多久、下班窗口在下班前多久开始、下班卡可延后
  in_advance_minutes   integer NOT NULL DEFAULT 120 CHECK (in_advance_minutes BETWEEN 0 AND 720),
  late_grace_minutes   integer NOT NULL DEFAULT 0 CHECK (late_grace_minutes BETWEEN 0 AND 240),
  in_after_minutes     integer NOT NULL DEFAULT 60 CHECK (in_after_minutes BETWEEN 0 AND 480),
  out_before_minutes   integer NOT NULL DEFAULT 60 CHECK (out_before_minutes BETWEEN 0 AND 480),
  out_delay_minutes    integer NOT NULL DEFAULT 120 CHECK (out_delay_minutes BETWEEN 0 AND 720),
  active               boolean NOT NULL DEFAULT true,
  version              integer NOT NULL DEFAULT 1,
  created_by           bigint REFERENCES staff (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           bigint REFERENCES staff (id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (start_minute <> end_minute),
  CHECK ((rest_start_minute IS NULL) = (rest_end_minute IS NULL)),
  CHECK (late_grace_minutes <= in_after_minutes)
);
CREATE UNIQUE INDEX oa_shifts_name_uq ON oa_shifts (store_id, lower(btrim(name)));

CREATE TABLE oa_locations (
  id          bigserial PRIMARY KEY,
  store_id    bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 30),
  address     text NOT NULL DEFAULT '' CHECK (char_length(address) <= 100),
  -- 经纬度（WGS-84，小数点后 6 位，约 0.1 米）
  lat         numeric(9, 6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         numeric(9, 6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  radius_m    integer NOT NULL DEFAULT 300 CHECK (radius_m BETWEEN 10 AND 3000),
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_by  bigint REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX oa_locations_name_uq ON oa_locations (store_id, lower(btrim(name)));

CREATE TABLE oa_attendance_groups (
  id             bigserial PRIMARY KEY,
  store_id       bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  name           text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 20),
  gps_required   boolean NOT NULL DEFAULT true,
  face_required  boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  version        integer NOT NULL DEFAULT 1,
  created_by     bigint REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint REFERENCES staff (id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX oa_attendance_groups_name_uq ON oa_attendance_groups (store_id, lower(btrim(name)));

CREATE TABLE oa_group_locations (
  group_id     bigint NOT NULL REFERENCES oa_attendance_groups (id),
  location_id  bigint NOT NULL REFERENCES oa_locations (id),
  PRIMARY KEY (group_id, location_id)
);

-- 一位员工只在一个考勤组里（主键是员工）
CREATE TABLE oa_group_members (
  staff_id   bigint PRIMARY KEY REFERENCES staff (id),
  group_id   bigint NOT NULL REFERENCES oa_attendance_groups (id),
  joined_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oa_group_members_group_idx ON oa_group_members (group_id);

INSERT INTO position_suggestions (position_key, permission) VALUES ('gmo', 'hr.attendance'), ('hr.lead', 'hr.attendance'), ('hr.staff', 'hr.attendance') ON CONFLICT DO NOTHING;

DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''oa_attendance_setup''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
