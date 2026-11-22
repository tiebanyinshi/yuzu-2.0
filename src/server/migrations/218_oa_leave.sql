-- OA-09 假期余额（docs/OA.md 第 12 节；需求文档四（五））。考勤月报按 oa_attendance_daily 现算，不另建表。
--   · oa_leave_types：假种（全公司一份）。paid = 带薪（不带薪的制表时扣薪参考），proof_required = 请假要证明附件，
--     has_balance = 管余额（请假要有余额，OA-13 扣），annual_tiers = 年假按工龄分档 [{"years":1,"days":5},…]（有的才自动发放）。
--     带默认五种（OA11，人事可以改）。
--   · oa_leave_balances：员工 + 假种 + 年度一行，存发放（含调整）与已用的合计，单位半天；改余额先锁这一行。
--   · oa_leave_entries：余额明细，只追加。kind：grant 自动发放（同一员工 + 假种 + 年度只有一条）、adjust 人事调整、
--     use / restore 请假扣减与撤销退回（OA-13）。halves 带正负。
-- 新建假种与人事调整带操作编号：操作编号与「确认作废」多两类 oa_leave_type、oa_leave_adjust（在当时的约束上追加）。
-- 回滚：docs/rollback/218_oa_leave.down.sql（删这三张表）。

CREATE TABLE oa_leave_types (
  id              bigserial PRIMARY KEY,
  name            text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 20),
  paid            boolean NOT NULL,
  proof_required  boolean NOT NULL DEFAULT false,
  has_balance     boolean NOT NULL DEFAULT false,
  annual_tiers    jsonb CHECK (annual_tiers IS NULL OR jsonb_typeof(annual_tiers) = 'array'),
  active          boolean NOT NULL DEFAULT true,
  sort            integer NOT NULL DEFAULT 0,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (annual_tiers IS NULL OR has_balance)
);

INSERT INTO oa_leave_types (name, paid, proof_required, has_balance, annual_tiers, sort) VALUES
  ('年假', true, false, true, '[{"years":1,"days":5},{"years":10,"days":10},{"years":20,"days":15}]', 1),
  ('事假', false, false, false, NULL, 2),
  ('病假', true, true, false, NULL, 3),
  ('婚假', true, true, false, NULL, 4),
  ('产假', true, true, false, NULL, 5);

CREATE TABLE oa_leave_balances (
  staff_id        bigint NOT NULL REFERENCES staff (id),
  leave_type_id   bigint NOT NULL REFERENCES oa_leave_types (id),
  year            integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  granted_halves  integer NOT NULL DEFAULT 0,
  used_halves     integer NOT NULL DEFAULT 0 CHECK (used_halves >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, leave_type_id, year),
  CHECK (granted_halves - used_halves >= 0)
);

CREATE TABLE oa_leave_entries (
  id              bigserial PRIMARY KEY,
  staff_id        bigint NOT NULL REFERENCES staff (id),
  leave_type_id   bigint NOT NULL REFERENCES oa_leave_types (id),
  year            integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  kind            text NOT NULL CHECK (kind IN ('grant', 'adjust', 'use', 'restore')),
  halves          integer NOT NULL CHECK (halves <> 0),
  reason          text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  ref_type        text,
  ref_id          bigint,
  created_by      bigint REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (staff_id, leave_type_id, year) REFERENCES oa_leave_balances (staff_id, leave_type_id, year),
  CHECK (kind <> 'adjust' OR (char_length(reason) >= 1 AND created_by IS NOT NULL))
);
CREATE UNIQUE INDEX oa_leave_entries_grant_uniq ON oa_leave_entries (staff_id, leave_type_id, year) WHERE kind = 'grant';
CREATE INDEX oa_leave_entries_balance_idx ON oa_leave_entries (staff_id, leave_type_id, year, id);

DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''oa_leave_type'', ''oa_leave_adjust''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
