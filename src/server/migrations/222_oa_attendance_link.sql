-- OA-13 考勤与审批联动（docs/OA.md 第 16 节；需求文档四（五）表 4-1、待确认第 7 条）。
--   · oa_attendance_covers：审批通过以后对考勤的覆盖（请假、出差），每张单每天一行。part = full 整天 / am 上午 / pm 下午；
--     halves = 这一天算了几个半天（请假：有排班的日子才算，不在考勤组的每天都算；出差为 0）；leave_type_id 请假才有。
--     只追加：已通过的单不会再变（销假 V1.1）。结算时按员工 + 日期读。
--   · oa_holidays / oa_holiday_years：节假日表（holiday 节假日 / workday 调休上班），按年整年保存，oa_holiday_years 记每年的版本。
--   · oa_punches.makeup_approval_id：补卡审批通过时写的那张卡关联的单（一张单最多一张）。
--   · oa_attendance_daily：结果加 leave 请假 / trip 出差；cover 记覆盖来源（leave / leave_am / leave_pm / trip）与 cover_approval_id。
-- 回滚：docs/rollback/222_oa_attendance_link.down.sql。

CREATE TABLE oa_attendance_covers (
  id             bigserial PRIMARY KEY,
  staff_id       bigint NOT NULL REFERENCES staff (id),
  work_date      date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('leave', 'trip')),
  part           text NOT NULL CHECK (part IN ('full', 'am', 'pm')),
  halves         integer NOT NULL DEFAULT 0 CHECK (halves BETWEEN 0 AND 2),
  leave_type_id  bigint REFERENCES oa_leave_types (id),
  approval_id    bigint NOT NULL REFERENCES oa_approvals (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_id, work_date),
  CHECK ((kind = 'leave') = (leave_type_id IS NOT NULL)),
  CHECK (kind = 'leave' OR (part = 'full' AND halves = 0))
);
CREATE INDEX oa_attendance_covers_staff_date_idx ON oa_attendance_covers (staff_id, work_date);

CREATE TABLE oa_holiday_years (
  year        integer PRIMARY KEY CHECK (year BETWEEN 2000 AND 2100),
  version     integer NOT NULL DEFAULT 1,
  updated_by  bigint REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oa_holidays (
  day   date PRIMARY KEY,
  kind  text NOT NULL CHECK (kind IN ('holiday', 'workday')),
  name  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 20)
);

ALTER TABLE oa_punches ADD COLUMN makeup_approval_id bigint REFERENCES oa_approvals (id);
CREATE UNIQUE INDEX oa_punches_makeup_uq ON oa_punches (makeup_approval_id) WHERE makeup_approval_id IS NOT NULL;

ALTER TABLE oa_attendance_daily DROP CONSTRAINT oa_attendance_daily_status_check;
ALTER TABLE oa_attendance_daily ADD CONSTRAINT oa_attendance_daily_status_check CHECK (status IN ('normal', 'abnormal', 'absent', 'leave', 'trip'));
ALTER TABLE oa_attendance_daily ADD COLUMN cover text CHECK (cover IN ('leave', 'leave_am', 'leave_pm', 'trip'));
ALTER TABLE oa_attendance_daily ADD COLUMN cover_approval_id bigint REFERENCES oa_approvals (id);
