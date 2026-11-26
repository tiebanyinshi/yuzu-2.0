-- 400 业财法审批流 P01：审批引擎与角色底座（店主 2026-11-26，设计见 docs/APPROVAL_V4.md）。
--   · gf_role_members：角色映射（财务审核人、财总、CFO、法务、CEO、董事长……），店主配置；可按经营主体（法人）限定，撤销只记时间不删；
--   · gf_docs：业财法事项（通用一张表，各批的业务字段放 payload），业务编号唯一，操作编号幂等；
--   · gf_flows：每提交一次一轮审批，审批链（节点）排好存下来；同一事项同时只有一轮在审；
--   · gf_flow_actions：同意 / 退回 / 驳回 / 自动跳过，只追加；同一轮同一级同一席只记一次同意；
--   · gf_cc：知会（不用同意），同一事项同一人只知会一次；大额 / 异常 / 特批即时提醒，其余进日报；
--   · gf_specials：微信特批（两人确认、唯一特批编号、1 个工作日内补登），gf_files：补登的需求说明、OK 截图等文件。
-- 状态不另建表：草稿 / 审核中 / 待执行 / 执行中 / 已完成 / 已归档 / 退回 / 驳回 / 撤回 / 特批待补登 / 后补待完成 / 逾期都从这几张表算。

CREATE TABLE gf_role_members (
  id          bigserial PRIMARY KEY,
  role        text NOT NULL CHECK (role IN ('finance_reviewer', 'finance_chief', 'cfo', 'legal', 'entity_head', 'chairman', 'business_gm',
                                            'supply_chain_head', 'seal_keeper', 'cashier', 'performer', 'internal_control', 'hr')),
  staff_id    bigint NOT NULL REFERENCES staff (id),
  -- 空 = 所有经营主体
  entity_id   bigint REFERENCES legal_entities (id),
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by  bigint REFERENCES staff (id),
  revoked_at  timestamptz,
  CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
CREATE UNIQUE INDEX gf_role_members_active_uq ON gf_role_members (role, staff_id, coalesce(entity_id, 0)) WHERE revoked_at IS NULL;

CREATE TABLE gf_docs (
  id                bigserial PRIMARY KEY,
  biz_no            text NOT NULL UNIQUE,
  doc_type          text NOT NULL CHECK (doc_type IN ('general')),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  entity_id         bigint REFERENCES legal_entities (id),
  department_id     bigint REFERENCES departments (id),
  -- 审批口径的金额（不含税，分）；无金额的为空
  amount_cents      bigint CHECK (amount_cents >= 0),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  flags             text[] NOT NULL DEFAULT '{}',
  performer_id      bigint REFERENCES staff (id),
  subject_staff_id  bigint REFERENCES staff (id),
  related_doc_id    bigint REFERENCES gf_docs (id),
  client_key        uuid NOT NULL UNIQUE,
  request_hash      text NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  created_by        bigint NOT NULL REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  withdrawn_at      timestamptz,
  withdrawn_by      bigint REFERENCES staff (id),
  exec_started_at   timestamptz,
  exec_started_by   bigint REFERENCES staff (id),
  completed_at      timestamptz,
  completed_by      bigint REFERENCES staff (id),
  archived_at       timestamptz,
  archived_by       bigint REFERENCES staff (id),
  -- 执行 / 补登的期限（逾期按这个算）
  due_on            date,
  -- 完成后还有没交的后补（发票、最终版……）
  backfill_open     boolean NOT NULL DEFAULT false
);
CREATE INDEX gf_docs_created_by_idx ON gf_docs (created_by, id DESC);

CREATE TABLE gf_flows (
  id                bigserial PRIMARY KEY,
  doc_id            bigint NOT NULL REFERENCES gf_docs (id),
  round             integer NOT NULL CHECK (round >= 1),
  nodes             jsonb NOT NULL CHECK (jsonb_typeof(nodes) = 'array' AND jsonb_array_length(nodes) BETWEEN 1 AND 12),
  notes             text[] NOT NULL DEFAULT '{}',
  current_level     integer NOT NULL DEFAULT 1 CHECK (current_level >= 1),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'returned', 'rejected', 'cancelled')),
  submitted_by      bigint NOT NULL REFERENCES staff (id),
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  level_started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  finished_by       bigint REFERENCES staff (id),
  UNIQUE (doc_id, round)
);
CREATE UNIQUE INDEX gf_flows_one_pending_uq ON gf_flows (doc_id) WHERE status = 'pending';

CREATE TABLE gf_flow_actions (
  id          bigserial PRIMARY KEY,
  flow_id     bigint NOT NULL REFERENCES gf_flows (id),
  level       integer NOT NULL CHECK (level >= 1),
  action      text NOT NULL CHECK (action IN ('approve', 'return', 'reject', 'skip')),
  -- 坐的哪一席：角色、dept_head、performer
  seat        text NOT NULL,
  actor_id    bigint NOT NULL REFERENCES staff (id),
  comment     text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
  client_key  uuid UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX gf_flow_actions_seat_uq ON gf_flow_actions (flow_id, level, seat) WHERE action IN ('approve', 'skip');
-- 同一级一个人只坐一席（会签要两个人）
CREATE UNIQUE INDEX gf_flow_actions_person_uq ON gf_flow_actions (flow_id, level, actor_id) WHERE action = 'approve';
CREATE TRIGGER gf_flow_actions_append_only BEFORE UPDATE OR DELETE ON gf_flow_actions FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE gf_cc (
  id           bigserial PRIMARY KEY,
  doc_id       bigint NOT NULL REFERENCES gf_docs (id),
  staff_id     bigint NOT NULL REFERENCES staff (id),
  role         text NOT NULL,
  urgent       boolean NOT NULL,
  reason       text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 即时提醒的写入时就发；日报的发了日报再填
  notified_at  timestamptz,
  read_at      timestamptz,
  UNIQUE (doc_id, staff_id)
);
CREATE INDEX gf_cc_digest_idx ON gf_cc (created_at) WHERE notified_at IS NULL;

CREATE TABLE gf_specials (
  id              bigserial PRIMARY KEY,
  special_no      text NOT NULL UNIQUE,
  doc_id          bigint REFERENCES gf_docs (id),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  reason          text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 500),
  confirmer_ids   bigint[] NOT NULL CHECK (cardinality(confirmer_ids) = 2 AND confirmer_ids[1] <> confirmer_ids[2]),
  confirmed_at    timestamptz NOT NULL,
  due_on          date NOT NULL,
  registered_by   bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  client_key      uuid NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  backfilled_at   timestamptz,
  backfilled_by   bigint REFERENCES staff (id),
  backfill_note   text NOT NULL DEFAULT '' CHECK (char_length(backfill_note) <= 500),
  CHECK ((backfilled_at IS NULL) = (backfilled_by IS NULL))
);

CREATE TABLE gf_files (
  id           bigserial PRIMARY KEY,
  owner_type   text NOT NULL CHECK (owner_type IN ('doc', 'special')),
  owner_id     bigint NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('need', 'ok_screenshot', 'attachment')),
  file_name    text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 120),
  mime         text NOT NULL,
  size_bytes   integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256       text NOT NULL,
  content      bytea NOT NULL,
  uploaded_by  bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gf_files_owner_idx ON gf_files (owner_type, owner_id);
CREATE TRIGGER gf_files_append_only BEFORE UPDATE OR DELETE ON gf_files FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
