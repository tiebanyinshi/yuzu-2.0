-- 420 业财法 P03：零星采购与备用金额度（docs/APPROVAL_V4.md 第 7 节）。
--   · gf_settings：业财法的设置（哪个部门是采购部门）；
--   · gf_dept_quotas：部门备用金额度（日 / 月），月度核定通过后从次月起生效，不自动升降；没有行的按默认日 1 万、月 5 万；
--   · gf_quota_ledger：额度台账（只追加）：冻结 / 解冻 / 实际占用 / 冲正，按费用承担部门 + 自然日；操作编号幂等；
--   · gf_quota_specials：超额合并特批（唯一特批编号，一次性专项额度只给本事项）；
--   · gf_overdue_reviews：保管人逾期后财总复核恢复的记录（只追加）；
--   · gf_docs 的事项类型加 petty_purchase（零星采购）、quota_adjust（月度额度核定）。

DO $$
BEGIN
  ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
  ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check
    CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change', 'petty_purchase', 'quota_adjust'));
END $$;

CREATE TABLE gf_settings (
  key         text PRIMARY KEY CHECK (key IN ('purchase_dept_id')),
  value       jsonb NOT NULL,
  updated_by  bigint NOT NULL REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gf_dept_quotas (
  id              bigserial PRIMARY KEY,
  department_id   bigint NOT NULL REFERENCES departments (id),
  -- 从哪个月起生效（每月 1 日）
  effective_month date NOT NULL CHECK (extract(day FROM effective_month) = 1),
  daily_cents     bigint NOT NULL CHECK (daily_cents > 0),
  monthly_cents   bigint NOT NULL CHECK (monthly_cents >= daily_cents),
  doc_id          bigint NOT NULL REFERENCES gf_docs (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, effective_month)
);

CREATE TABLE gf_quota_ledger (
  id             bigserial PRIMARY KEY,
  department_id  bigint NOT NULL REFERENCES departments (id),
  biz_date       date NOT NULL,
  -- freeze 冻结、unfreeze 解冻（取消 / 驳回 / 验收时转出）、use 实际占用、reverse 冲正（追加负数，不删历史）
  kind           text NOT NULL CHECK (kind IN ('freeze', 'unfreeze', 'use', 'reverse')),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  doc_id         bigint NOT NULL REFERENCES gf_docs (id),
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  op_key         text NOT NULL UNIQUE,
  created_by     bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gf_quota_ledger_dept_idx ON gf_quota_ledger (department_id, biz_date);
CREATE INDEX gf_quota_ledger_doc_idx ON gf_quota_ledger (doc_id);
CREATE TRIGGER gf_quota_ledger_append_only BEFORE UPDATE OR DELETE ON gf_quota_ledger FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE gf_quota_specials (
  id            bigserial PRIMARY KEY,
  special_no    text NOT NULL UNIQUE,
  doc_id        bigint NOT NULL UNIQUE REFERENCES gf_docs (id),
  over_daily    boolean NOT NULL,
  over_monthly  boolean NOT NULL,
  purchase_dept boolean NOT NULL DEFAULT false,
  over_cents    bigint NOT NULL CHECK (over_cents >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gf_overdue_reviews (
  id           bigserial PRIMARY KEY,
  staff_id     bigint NOT NULL REFERENCES staff (id),
  reviewed_by  bigint NOT NULL REFERENCES staff (id),
  note         text NOT NULL CHECK (char_length(note) BETWEEN 2 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gf_overdue_reviews_staff_idx ON gf_overdue_reviews (staff_id, created_at DESC);
CREATE TRIGGER gf_overdue_reviews_append_only BEFORE UPDATE OR DELETE ON gf_overdue_reviews FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
