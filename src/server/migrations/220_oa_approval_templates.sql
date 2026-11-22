-- OA-11 六类审批模板（docs/OA.md 第 14 节；需求文档五（二））：在 OA-10 的「通用」之外加请假、加班、出差、报销、补卡。
-- 都是一级本部门主管；请假开「超过 3 天加签」、报销开「超过 5000 元加签」。时长、天数由提交时的模板挂接点算好放进表单
-- （请假 durationHalves、加班 minutes、出差 days）。与考勤、假期余额的联动在 OA-13。
-- 回滚：docs/rollback/220_oa_approval_templates.down.sql（只删这五个模板，前提是还没有用它们提交的单）。

INSERT INTO oa_approval_templates (code, name, description, fields, levels, conditions, sort) VALUES
(
  'leave', '请假', '按排班算时长，管余额的假种要有余额',
  '[{"key":"leaveTypeId","label":"假种","type":"leave_type","required":true},
    {"key":"start","label":"开始","type":"halfday","required":true},
    {"key":"end","label":"结束","type":"halfday","required":true},
    {"key":"reason","label":"事由","type":"textarea","required":true,"max":500},
    {"key":"attachments","label":"附件","type":"attachments","max":9,"hint":"病假、婚假、产假等要证明的假种必须上传"}]',
  '[{"kind":"dept_head"}]', '{"leave_over_3_days":true}', 10
),
(
  'overtime', '加班', '时长按开始、结束算，一张最长 24 小时',
  '[{"key":"start","label":"开始","type":"datetime","required":true},
    {"key":"end","label":"结束","type":"datetime","required":true},
    {"key":"kind","label":"加班类型","type":"select","required":true,"options":["工作日","休息日","节假日"]},
    {"key":"reason","label":"事由","type":"textarea","required":true,"max":500}]',
  '[{"kind":"dept_head"}]', '{}', 20
),
(
  'trip', '出差', '出差期间的考勤按出差算（审批通过以后）',
  '[{"key":"destination","label":"出差地","type":"text","required":true,"max":40},
    {"key":"startDate","label":"开始日期","type":"date","required":true},
    {"key":"endDate","label":"结束日期","type":"date","required":true},
    {"key":"transport","label":"交通方式","type":"select","required":true,"options":["飞机","火车","汽车","自驾","其他"]},
    {"key":"reason","label":"事由","type":"textarea","required":true,"max":500}]',
  '[{"kind":"dept_head"}]', '{}', 30
),
(
  'expense', '报销', '发票至少一张；超过 5000 元加签总经办',
  '[{"key":"category","label":"费用类型","type":"select","required":true,"options":["交通","住宿","餐饮","办公用品","招待","其他"]},
    {"key":"amount","label":"金额","type":"money","required":true,"min":1,"max":100000000},
    {"key":"occurredOn","label":"发生日期","type":"date","required":true},
    {"key":"invoices","label":"发票","type":"attachments","required":true,"max":9},
    {"key":"tripId","label":"关联出差单","type":"ref","refTemplate":"trip","hint":"可不选；只能选自己已通过的出差单"},
    {"key":"note","label":"说明","type":"textarea","max":500}]',
  '[{"kind":"dept_head"}]', '{"expense_over_5000":true}', 40
),
(
  'makeup', '补卡', '今天及以前 30 天内、自己排了的班',
  '[{"key":"date","label":"日期","type":"date","required":true},
    {"key":"shiftId","label":"班次","type":"shift","required":true},
    {"key":"kind","label":"补哪张卡","type":"select","required":true,"options":["上班卡","下班卡"]},
    {"key":"reason","label":"漏卡原因","type":"textarea","required":true,"max":200}]',
  '[{"kind":"dept_head"}]', '{}', 50
);
