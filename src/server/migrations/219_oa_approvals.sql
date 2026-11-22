-- OA-10 办公审批引擎（docs/OA.md 第 13 节；需求文档五（一））。另建，不动审批中心。
--   · oa_approval_templates：模板 = 元数据。fields = 表单字段 [{key,label,type,required,max,min,options}]，
--     levels = 审批人 1–3 级 [{kind:'staff',staffId}|{kind:'dept_head'}|{kind:'parent_head'}]，conditions = 条件开关 {code: true}，
--     cc = 抄送 [{kind:'staff',staffId}|{kind:'dept_head'}]。带「通用」模板（OA-11 用迁移加请假、加班、出差、报销、补卡）。
--   · oa_approvals：一张单。提交时把模板名与字段抄一份（之后改模板不影响在途与历史的单）。驳回以后重新提交是新的一张：
--     previous_id 指向上一张、revision 加一，上一张留着。version 每处理一次加一。
--   · oa_approval_steps：审批链，提交时定下来；一级一行，转交 = 这一行记「已转交」、同一级再加一行给接手的人。
--     original_approver_id 留给委托（V1.1）。
--   · oa_approval_events：时间线（提交、通过、驳回、转交、撤销、评论、催办），只追加。
--   · oa_approval_cc：抄送与已读。
-- 提交与处理带操作编号：操作编号与「确认作废」多两类 oa_approval_submit、oa_approval_act（在当时的约束上追加）。
-- 回滚：docs/rollback/219_oa_approvals.down.sql。

CREATE TABLE oa_approval_templates (
  id           bigserial PRIMARY KEY,
  code         text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]{1,30}$'),
  name         text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 20),
  description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  fields       jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  levels       jsonb NOT NULL CHECK (jsonb_typeof(levels) = 'array' AND jsonb_array_length(levels) BETWEEN 1 AND 3),
  conditions   jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(conditions) = 'object'),
  cc           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(cc) = 'array'),
  active       boolean NOT NULL DEFAULT true,
  sort         integer NOT NULL DEFAULT 0,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO oa_approval_templates (code, name, description, fields, levels, sort) VALUES (
  'general', '通用', '其他事项（用章申请等先用这个）',
  '[{"key":"title","label":"标题","type":"text","required":true,"max":60},{"key":"content","label":"内容","type":"textarea","required":true,"max":2000},{"key":"attachments","label":"附件","type":"attachments","max":9}]',
  '[{"kind":"dept_head"}]', 90);

CREATE TABLE oa_approvals (
  id             bigserial PRIMARY KEY,
  store_id       bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  template_id    bigint NOT NULL REFERENCES oa_approval_templates (id),
  template_code  text NOT NULL,
  template_name  text NOT NULL,
  fields         jsonb NOT NULL,
  applicant_id   bigint NOT NULL REFERENCES staff (id),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  form           jsonb NOT NULL CHECK (jsonb_typeof(form) = 'object'),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  revision       integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  previous_id    bigint UNIQUE REFERENCES oa_approvals (id),
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  last_urged_at  timestamptz,
  version        integer NOT NULL DEFAULT 1,
  CHECK ((status = 'pending') = (finished_at IS NULL)),
  CHECK ((previous_id IS NULL) = (revision = 1))
);
CREATE INDEX oa_approvals_applicant_idx ON oa_approvals (applicant_id, id);
CREATE INDEX oa_approvals_status_idx ON oa_approvals (status, id);

CREATE TABLE oa_approval_steps (
  id                    bigserial PRIMARY KEY,
  approval_id           bigint NOT NULL REFERENCES oa_approvals (id),
  seq                   integer NOT NULL CHECK (seq BETWEEN 1 AND 10),
  label                 text NOT NULL,
  approver_id           bigint NOT NULL REFERENCES staff (id),
  original_approver_id  bigint REFERENCES staff (id),
  status                text NOT NULL CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'transferred', 'cancelled')),
  transferred_to        bigint REFERENCES oa_approval_steps (id),
  comment               text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
  acted_at              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'transferred') = (transferred_to IS NOT NULL))
);
CREATE INDEX oa_approval_steps_approval_idx ON oa_approval_steps (approval_id, seq, id);
CREATE UNIQUE INDEX oa_approval_steps_one_pending ON oa_approval_steps (approval_id) WHERE status = 'pending';
CREATE INDEX oa_approval_steps_todo_idx ON oa_approval_steps (approver_id, approval_id) WHERE status = 'pending';
CREATE INDEX oa_approval_steps_approver_idx ON oa_approval_steps (approver_id, approval_id);

CREATE TABLE oa_approval_events (
  id           bigserial PRIMARY KEY,
  approval_id  bigint NOT NULL REFERENCES oa_approvals (id),
  actor_id     bigint NOT NULL REFERENCES staff (id),
  kind         text NOT NULL CHECK (kind IN ('submit', 'approve', 'reject', 'transfer', 'withdraw', 'comment', 'urge')),
  step_id      bigint REFERENCES oa_approval_steps (id),
  to_staff_id  bigint REFERENCES staff (id),
  comment      text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (kind NOT IN ('reject', 'comment') OR char_length(comment) >= 1),
  CHECK ((kind = 'transfer') = (to_staff_id IS NOT NULL))
);
CREATE INDEX oa_approval_events_approval_idx ON oa_approval_events (approval_id, id);

CREATE TABLE oa_approval_cc (
  approval_id  bigint NOT NULL REFERENCES oa_approvals (id),
  staff_id     bigint NOT NULL REFERENCES staff (id),
  read_at      timestamptz,
  PRIMARY KEY (approval_id, staff_id)
);
CREATE INDEX oa_approval_cc_staff_idx ON oa_approval_cc (staff_id, approval_id);

DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''oa_approval_submit'', ''oa_approval_act''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
