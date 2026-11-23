-- OA-18 发放、签收与薪资安全审计（docs/OA.md 第 21 节，OA22；需求文档七（二）、七（三））。
--   · oa_payroll_batches：published_at / published_by = 发放（之后不能改、不能作废）；reminded_at = 最近一次「一键提醒」（同一张表 10 分钟一次）。
--   · oa_payslips：signed_at = 员工确认签收的时间（签过不变）；viewed_at = 员工第一次打开的时间。
--   · 办公审批模板「工资条异议」：审批人默认人力行政部负责人（新的审批人类型 hr_head）。
-- 回滚：docs/rollback/226_oa_payroll_publish.down.sql。

ALTER TABLE oa_payroll_batches
  ADD COLUMN published_at  timestamptz,
  ADD COLUMN published_by  bigint REFERENCES staff (id),
  ADD COLUMN reminded_at   timestamptz,
  ADD CONSTRAINT oa_payroll_batches_published CHECK ((status = 'published') = (published_at IS NOT NULL));

ALTER TABLE oa_payslips
  ADD COLUMN signed_at  timestamptz,
  ADD COLUMN viewed_at  timestamptz;

-- 员工端按人取（本人的工资条列表）
CREATE INDEX oa_payslips_staff_signed_idx ON oa_payslips (staff_id, signed_at);

INSERT INTO oa_approval_templates (code, name, description, fields, levels, sort) VALUES (
  'payslip_objection', '工资条异议', '对某个月的工资条有疑问：写清哪一项、为什么',
  '[{"key":"payslip","label":"工资条","type":"text","required":true,"max":60,"hint":"从工资条页点「有异议」会自动填好"},
    {"key":"content","label":"异议说明","type":"textarea","required":true,"max":1000},
    {"key":"attachments","label":"附件","type":"attachments","max":9}]',
  '[{"kind":"hr_head"}]', 70
) ON CONFLICT (code) DO NOTHING;
