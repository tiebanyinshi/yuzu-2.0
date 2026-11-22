-- OA-05 排班（docs/OA.md 第 8 节；需求文档四（三））。
--   · oa_schedules：某位员工某个业务日期上某个班次（业务日期 = 班次开始那天，跨天班的下班卡也记在这一天）。
--     同一人同一天可以有几个班次（连班），唯一键 员工 + 日期 + 班次；没排的日子按休息算（不存行）。
--     consecutive = 标了「连班」：与同一人前后相邻的班次打卡窗口可以首尾相接（服务端保存时核对）。
--   · 按门店分；只能改今天及以后的日子，改动记审计（audit_logs，oa_schedule_saved）。
-- 新权限项 hr.attendanceDept（本部门的排班与考勤查看）：建议权限给各部门负责人与总经办（与 src/shared/positions.ts 的 POSITION_DEFAULTS 一致）。
-- 回滚：docs/rollback/214_oa_schedules.down.sql（删这张表、撤掉建议权限）。

CREATE TABLE oa_schedules (
  id           bigserial PRIMARY KEY,
  store_id     bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  staff_id     bigint NOT NULL REFERENCES staff (id),
  work_date    date NOT NULL,
  shift_id     bigint NOT NULL REFERENCES oa_shifts (id),
  consecutive  boolean NOT NULL DEFAULT false,
  created_by   bigint REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint REFERENCES staff (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, work_date, shift_id)
);
CREATE INDEX oa_schedules_store_date_idx ON oa_schedules (store_id, work_date);
CREATE INDEX oa_schedules_staff_date_idx ON oa_schedules (staff_id, work_date);

INSERT INTO position_suggestions (position_key, permission)
SELECT k, 'hr.attendanceDept'
FROM unnest(ARRAY['gmo', 'hr.lead', 'front.lead', 'male.lead', 'female.lead', 'ent.lead', 'dining.lead', 'kangmei.lead', 'kitchen.lead',
                  'wellness.lead', 'eng.lead', 'finance.lead', 'outreach.lead', 'vip.lead']) AS k
ON CONFLICT DO NOTHING;
