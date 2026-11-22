-- OA-01（店主 2026-11-22《企业 OA 审批 + 考勤打卡系统需求文档》，docs/OA.md 第 4 节，OA1–OA5）：组织架构与员工档案。
-- 部门沿用 8.1.18 的 15 个部门（org_departments，OA1：不增删），补「上级部门」与「指定主管」；
-- 员工档案（工号、手机号、入职 / 离职日期、在职状态）另建一张表，与账号一对一，历史数据一律不删。
-- 新权限项 hr.org（组织架构与员工档案）：建议权限给人力行政部负责人（算「账号与权限配置」那一列，部门员工不开）（与 src/shared/positions.ts 的 POSITION_DEFAULTS 一致，
-- tests/position-catalog.test.ts 核对）。
-- 回滚：docs/rollback/210_oa_org.down.sql（删档案表与两列、撤掉 hr.org 的建议权限；账号本身不动）。

ALTER TABLE org_departments
  ADD COLUMN parent_key    text REFERENCES org_departments (key),
  ADD COLUMN head_staff_id bigint REFERENCES staff (id),
  ADD COLUMN version       integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT org_departments_parent_not_self CHECK (parent_key IS NULL OR parent_key <> key);

-- 公司在最上；总经办挂公司下；其余部门默认挂总经办下（后台可改）
UPDATE org_departments SET parent_key = 'company' WHERE key = 'gmo';
UPDATE org_departments SET parent_key = 'gmo' WHERE key NOT IN ('company', 'gmo');

CREATE TABLE staff_profiles (
  staff_id    bigint PRIMARY KEY REFERENCES staff (id),
  emp_no      text UNIQUE CHECK (emp_no IS NULL OR emp_no ~ '^[A-Za-z0-9_-]{1,20}$'),
  phone       text CHECK (phone IS NULL OR phone ~ '^1[0-9]{10}$'),
  hire_date   date,
  leave_date  date,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  -- 乐观并发：后台改档案带着页面看到的版本，别人先改过就不能覆盖
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint REFERENCES staff (id),
  CHECK (status = 'left' OR leave_date IS NULL),
  CHECK (leave_date IS NULL OR hire_date IS NULL OR leave_date >= hire_date)
);
CREATE UNIQUE INDEX staff_profiles_phone_key ON staff_profiles (phone) WHERE phone IS NOT NULL AND status = 'active';

INSERT INTO position_suggestions (position_key, permission) VALUES ('hr.lead', 'hr.org') ON CONFLICT DO NOTHING;
