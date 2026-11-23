-- OA-17 工资条模板与制表（docs/OA.md 第 20 节；需求文档七（一）、七（三））。
--   · oa_payslip_templates：工资条模板（字段：名称、类型 money 金额 / number 数字 / text 文字、哪一项是「实发」），HR 在后台维护；停用不删。
--     带一份「标准工资条」（需求文档列的十个字段）。
--   · oa_payroll_batches：工资表（月份 + 标题 + 门店范围；建表时把模板的字段抄一份，之后改模板不影响）。状态 draft 草稿 / published 已发放（OA-18）/ void 作废。
--   · oa_payslips：一张工资表一人一行，values = 各字段的值（金额按分存的整数，数字、文字照原样）。
--   · oa_payroll_files：上传的 Excel 原件，AES-256-GCM 加密（密钥在服务器 .env 的 PAYROLL_FILE_KEY，库里只记指纹）。
--   · oa_payroll_audit：薪资的敏感操作（看明细、预览某人的工资条、下载表格、下载原件；OA-18 起还有发放、员工查看、签收），不记金额。
--   · 权限项 payroll.manage 的建议权限：人力行政部负责人（总裁默认都有）。
-- 加锁：模板行 → 工资表行（FOR UPDATE）→ 工资条行。回滚：docs/rollback/225_oa_payroll.down.sql。

CREATE TABLE oa_payslip_templates (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  fields      jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) BETWEEN 1 AND 40),
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_by  bigint REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX oa_payslip_templates_name_uq ON oa_payslip_templates (name) WHERE active;

CREATE TABLE oa_payroll_batches (
  id           bigserial PRIMARY KEY,
  month        text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 40),
  template_id  bigint NOT NULL REFERENCES oa_payslip_templates (id),
  fields       jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) BETWEEN 1 AND 40),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'void')),
  -- 门店范围：建表人能管的门店（排好序）；空 = 全部门店（总裁建的）。名单按它取，别的门店的 HR 看不到（Codex 安全审查 f6c14e7）
  store_ids    bigint[] CHECK (store_ids IS NULL OR cardinality(store_ids) > 0),
  created_by   bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint REFERENCES staff (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  voided_by    bigint REFERENCES staff (id),
  voided_at    timestamptz,
  CHECK ((status = 'void') = (voided_at IS NOT NULL))
);
CREATE UNIQUE INDEX oa_payroll_batches_title_uq ON oa_payroll_batches (month, title, COALESCE(store_ids, '{}'::bigint[])) WHERE status <> 'void';
CREATE INDEX oa_payroll_batches_month_idx ON oa_payroll_batches (month DESC, id DESC);

CREATE TABLE oa_payslips (
  id          bigserial PRIMARY KEY,
  batch_id    bigint NOT NULL REFERENCES oa_payroll_batches (id),
  staff_id    bigint NOT NULL REFERENCES staff (id),
  values      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(values) = 'object'),
  updated_by  bigint REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, staff_id)
);
CREATE INDEX oa_payslips_staff_idx ON oa_payslips (staff_id, batch_id);

CREATE TABLE oa_payroll_files (
  id           bigserial PRIMARY KEY,
  batch_id     bigint NOT NULL REFERENCES oa_payroll_batches (id),
  file_name    text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  size         integer NOT NULL CHECK (size > 0),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- AES-256-GCM：iv 12 字节、tag 16 字节；key_id = 密钥指纹（sha256 的前 16 位十六进制），换了密钥能认出来
  iv           bytea NOT NULL CHECK (octet_length(iv) = 12),
  tag          bytea NOT NULL CHECK (octet_length(tag) = 16),
  ciphertext   bytea NOT NULL,
  key_id       text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  row_count    integer NOT NULL CHECK (row_count >= 0),
  uploaded_by  bigint NOT NULL REFERENCES staff (id),
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oa_payroll_files_batch_idx ON oa_payroll_files (batch_id, id DESC);

CREATE TABLE oa_payroll_audit (
  id          bigserial PRIMARY KEY,
  staff_id    bigint REFERENCES staff (id),
  action      text NOT NULL CHECK (action ~ '^[a-z_]{2,40}$'),
  batch_id    bigint REFERENCES oa_payroll_batches (id),
  target_id   bigint REFERENCES staff (id),
  file_id     bigint REFERENCES oa_payroll_files (id),
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oa_payroll_audit_time_idx ON oa_payroll_audit (created_at DESC, id DESC);
CREATE INDEX oa_payroll_audit_batch_idx ON oa_payroll_audit (batch_id, id DESC);

INSERT INTO oa_payslip_templates (name, fields) VALUES (
  '标准工资条',
  '[{"key":"f1","label":"基本工资","kind":"money"},{"key":"f2","label":"岗位津贴","kind":"money"},{"key":"f3","label":"绩效工资","kind":"money"},{"key":"f4","label":"加班费","kind":"money"},{"key":"f5","label":"社保扣款","kind":"money"},{"key":"f6","label":"公积金扣款","kind":"money"},{"key":"f7","label":"个税","kind":"money"},{"key":"f8","label":"其他扣款","kind":"money"},{"key":"f9","label":"应发合计","kind":"money"},{"key":"f10","label":"实发合计","kind":"money","net":true}]'::jsonb
);

INSERT INTO position_suggestions (position_key, permission) VALUES ('hr.lead', 'payroll.manage') ON CONFLICT DO NOTHING;
