-- 员工办公 v1.1 第 4 批（docs/OA_MOBILE.md 第 5 节）：新增「用章」审批模板（seal）。
-- 仅追加一条模板记录，不动已有模板与历史审批单；ON CONFLICT 保证重复执行安全。
-- 回滚：docs/rollback/293_oa_seal_template.down.sql（前提是还没有用该模板提交的审批单）。

INSERT INTO oa_approval_templates (code, name, description, fields, levels, conditions, sort)
VALUES (
  'seal',
  '用章',
  '公章、合同专用章、财务专用章等用印审批',
  '[{"key":"sealType","label":"印章类型","type":"select","required":true,"options":["公章","合同专用章","财务专用章","法人章","其他"]},
    {"key":"docName","label":"用章文件名称","type":"text","required":true,"max":60},
    {"key":"copies","label":"用章份数","type":"number","required":true,"min":1,"max":999},
    {"key":"useDate","label":"用章日期","type":"date","required":true},
    {"key":"reason","label":"用章事由","type":"textarea","required":true,"max":500},
    {"key":"attachments","label":"附件","type":"attachments","max":9,"hint":"可上传需盖章的文件扫描件或草稿"}]',
  '[{"kind":"dept_head"}]',
  '{}',
  60
)
ON CONFLICT (code) DO NOTHING;
