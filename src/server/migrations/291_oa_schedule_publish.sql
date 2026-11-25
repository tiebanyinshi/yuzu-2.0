-- 员工办公 v1.1 第 2 批（docs/OA_MOBILE.md 第 3、5 节；EO5）：排班「发布」才生效、才通知。
--   · oa_schedule_publishes：每次发布排班留一条记录（门店、考勤组、起止日期、涉及员工数与格子数、发布人、操作编号，只追加）。
--   · oa_schedules 加发布状态：
--       status = 'draft' / 'published'（默认 'published'，已有数据与未传该列的旧写入仍视为已发布）；
--       pending_delete = 已发布行在草稿中被去掉，发布时再真正删掉（发布前仍按原已发布排班打卡、结算、员工可见）；
--       draft_consecutive = 已发布行在草稿中改了「连班」标记，发布时再覆盖 consecutive；
--       published_at / published_by / publish_id = 最近一次发布的时刻、经办人与发布批次。
--   · 操作编号与「确认作废」的类型约束追加 oa_schedule_publish（在当时的约束上追加）。
-- 回滚：docs/rollback/291_oa_schedule_publish.down.sql。

CREATE TABLE oa_schedule_publishes (
  id           bigserial PRIMARY KEY,
  store_id     bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  group_id     bigint NOT NULL REFERENCES oa_attendance_groups (id),
  from_date    date NOT NULL,
  to_date      date NOT NULL,
  staff_count  integer NOT NULL CHECK (staff_count >= 0),
  cell_count   integer NOT NULL CHECK (cell_count >= 0),
  published_by bigint NOT NULL REFERENCES staff (id),
  client_key   uuid NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date)
);
CREATE INDEX oa_schedule_publishes_store_group_idx ON oa_schedule_publishes (store_id, group_id, created_at DESC);

ALTER TABLE oa_schedules
  ADD COLUMN status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
  ADD COLUMN pending_delete boolean NOT NULL DEFAULT false,
  ADD COLUMN draft_consecutive boolean,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN published_by bigint REFERENCES staff (id),
  ADD COLUMN publish_id bigint REFERENCES oa_schedule_publishes (id),
  ADD CONSTRAINT oa_schedules_draft_state_check CHECK (status = 'published' OR (NOT pending_delete AND draft_consecutive IS NULL));

UPDATE oa_schedules
SET published_at = updated_at, published_by = updated_by
WHERE status = 'published' AND published_at IS NULL;

CREATE INDEX oa_schedules_store_unpublished_idx
  ON oa_schedules (store_id, work_date)
  WHERE status = 'draft' OR pending_delete OR draft_consecutive IS NOT NULL;

DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''oa_schedule_publish''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
