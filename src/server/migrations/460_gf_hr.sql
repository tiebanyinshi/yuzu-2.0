-- 460 业财法 P07：人力资源付款批次与费用分摊引擎（docs/APPROVAL_V4.md 第 11 节）。
--   · gf_docs 的事项类型加 hr_batch（HR 付款批次）；
--   · gf_hr_batches：批次（批次号唯一、类型、期间、原批次、人数、总额、凭证、账户摘要）；gf_hr_batch_lines：人员明细（只追加）；
--   · gf_hr_payouts：出纳按批次付款（流水号唯一，只追加）；gf_hr_checks：出纳复核记录（含不一致退回，只追加）；
--   · gf_alloc_rules / gf_alloc_rule_versions：分摊规则与版本（版本只追加）；gf_alloc_runs：分摊执行结果与冲正（只追加，不能删）。

DO $$
BEGIN
  ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
  ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check
    CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change', 'petty_purchase', 'quota_adjust', 'contract', 'payment',
                        'expense', 'travel', 'entertain', 'seal_use', 'hr_batch'));
END $$;

CREATE TABLE gf_hr_batches (
  id                 bigserial PRIMARY KEY,
  doc_id             bigint NOT NULL UNIQUE REFERENCES gf_docs (id),
  batch_no           text NOT NULL UNIQUE,
  kind               text NOT NULL CHECK (kind IN ('salary', 'commission', 'cash_benefit', 'supplement', 'adjustment', 'separation', 'extra_bonus')),
  period             text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  department_id      bigint NOT NULL REFERENCES departments (id),
  original_batch_id  bigint REFERENCES gf_hr_batches (id),
  headcount          integer NOT NULL CHECK (headcount > 0),
  total_cents        bigint NOT NULL CHECK (total_cents > 0),
  accounts_digest    text NOT NULL,
  evidence           jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('supplement', 'adjustment', 'separation', 'extra_bonus')) = (original_batch_id IS NOT NULL))
);
-- 常规批次（工资 / 提成 / 现金福利）同一部门同一期间只有一批；异常的另走
CREATE UNIQUE INDEX gf_hr_batches_regular_uq ON gf_hr_batches (kind, period, department_id) WHERE kind IN ('salary', 'commission', 'cash_benefit');

CREATE TABLE gf_hr_batch_lines (
  id             bigserial PRIMARY KEY,
  batch_id       bigint NOT NULL REFERENCES gf_hr_batches (id),
  staff_id       bigint NOT NULL REFERENCES staff (id),
  amount_cents   bigint NOT NULL CHECK (amount_cents <> 0),
  account        text NOT NULL CHECK (account ~ '^[0-9]{6,30}$'),
  cost_dept_id   bigint NOT NULL REFERENCES departments (id),
  UNIQUE (batch_id, staff_id)
);
CREATE TRIGGER gf_hr_batch_lines_append_only BEFORE UPDATE OR DELETE ON gf_hr_batch_lines FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE gf_hr_checks (
  id           bigserial PRIMARY KEY,
  batch_id     bigint NOT NULL REFERENCES gf_hr_batches (id),
  ok           boolean NOT NULL,
  mismatches   text[] NOT NULL DEFAULT '{}',
  checked_by   bigint NOT NULL REFERENCES staff (id),
  checked_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER gf_hr_checks_append_only BEFORE UPDATE OR DELETE ON gf_hr_checks FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE gf_hr_payouts (
  id          bigserial PRIMARY KEY,
  batch_id    bigint NOT NULL UNIQUE REFERENCES gf_hr_batches (id),
  bank_ref    text NOT NULL UNIQUE CHECK (char_length(bank_ref) BETWEEN 4 AND 60),
  paid_by     bigint NOT NULL REFERENCES staff (id),
  paid_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER gf_hr_payouts_append_only BEFORE UPDATE OR DELETE ON gf_hr_payouts FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE gf_alloc_rules (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 60),
  version     integer NOT NULL DEFAULT 1,
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gf_alloc_rule_versions (
  rule_id     bigint NOT NULL REFERENCES gf_alloc_rules (id),
  version     integer NOT NULL,
  splits      jsonb NOT NULL CHECK (jsonb_typeof(splits) = 'array'),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, version)
);
CREATE TRIGGER gf_alloc_rule_versions_append_only BEFORE UPDATE OR DELETE ON gf_alloc_rule_versions FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE gf_alloc_runs (
  id               bigserial PRIMARY KEY,
  rule_id          bigint NOT NULL,
  rule_version     integer NOT NULL,
  source_doc_id    bigint REFERENCES gf_docs (id),
  kind             text NOT NULL CHECK (kind IN ('run', 'reverse')),
  amount_cents     bigint NOT NULL,
  lines            jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  reverses_run_id  bigint UNIQUE REFERENCES gf_alloc_runs (id),
  reason           text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  client_key       uuid NOT NULL UNIQUE,
  created_by       bigint NOT NULL REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (rule_id, rule_version) REFERENCES gf_alloc_rule_versions (rule_id, version),
  CHECK ((kind = 'reverse') = (reverses_run_id IS NOT NULL))
);
CREATE TRIGGER gf_alloc_runs_append_only BEFORE UPDATE OR DELETE ON gf_alloc_runs FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
