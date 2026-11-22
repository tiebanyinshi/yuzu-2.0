-- OA-08 考勤结算（docs/OA.md 第 11 节；需求文档四（五））。
--   · oa_attendance_daily：每条排班（员工 + 业务日期 + 班次）结算成一条。下班窗口结束以后才结算；之后又有新打卡的重新结算，
--     重写计算出来的那几列（结果、迟到早退分钟、缺卡、有效卡、外勤、人脸待核对），人事对外勤的决定（outwork_counted）保留。
--     status：normal 正常 / abnormal 有异常（迟到、早退、缺一张卡） / absent 旷工（两张卡都没有）。
--   · notified：第一次算成异常时给员工发过「打卡异常」通知（之后又变正常、再变异常不再发）。
--   · 按排班的门店记；排班行会被重写（保存排班），这里不引用排班行的 id。
-- 回滚：docs/rollback/217_oa_attendance_daily.down.sql。

CREATE TABLE oa_attendance_daily (
  id               bigserial PRIMARY KEY,
  store_id         bigint NOT NULL REFERENCES stores (id),
  staff_id         bigint NOT NULL REFERENCES staff (id),
  business_date    date NOT NULL,
  shift_id         bigint NOT NULL REFERENCES oa_shifts (id),
  status           text NOT NULL CHECK (status IN ('normal', 'abnormal', 'absent')),
  late_minutes     integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_minutes    integer NOT NULL DEFAULT 0 CHECK (early_minutes >= 0),
  missing_in       boolean NOT NULL DEFAULT false,
  missing_out      boolean NOT NULL DEFAULT false,
  in_punch_id      bigint REFERENCES oa_punches (id),
  out_punch_id     bigint REFERENCES oa_punches (id),
  outwork          boolean NOT NULL DEFAULT false,
  outwork_counted  boolean NOT NULL DEFAULT true,
  outwork_by       bigint REFERENCES staff (id),
  outwork_at       timestamptz,
  face_pending     boolean NOT NULL DEFAULT false,
  notified         boolean NOT NULL DEFAULT false,
  settled_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, business_date, shift_id)
);
CREATE INDEX oa_attendance_daily_store_date_idx ON oa_attendance_daily (store_id, business_date);
CREATE INDEX oa_attendance_daily_staff_date_idx ON oa_attendance_daily (staff_id, business_date);
