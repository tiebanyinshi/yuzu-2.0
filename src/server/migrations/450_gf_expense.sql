-- 450 业财法 P06：报销、出差、商务招待、用印证照（docs/APPROVAL_V4.md 第 10 节）。
--   · gf_docs 的事项类型加 expense（报销）、travel（出差申请）、entertain（商务招待）、seal_use（用印证照）；
--   · gf_travel_budgets：部门月度差旅批复额度（财总设）；gf_travel_ledger：差旅台账（冻结 / 解冻 / 实际占用，转下月的记在下月，只追加）；
--   · gf_licenses：证照（电子只发水印副本、纸质借还）；gf_license_loans：纸质证照借还记录（同一证照同时只借出一次）。

DO $$
BEGIN
  ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
  ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check
    CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change', 'petty_purchase', 'quota_adjust', 'contract', 'payment',
                        'expense', 'travel', 'entertain', 'seal_use'));
END $$;

CREATE TABLE gf_travel_budgets (
  department_id  bigint NOT NULL REFERENCES departments (id),
  month          date NOT NULL CHECK (extract(day FROM month) = 1),
  budget_cents   bigint NOT NULL CHECK (budget_cents >= 0),
  updated_by     bigint NOT NULL REFERENCES staff (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, month)
);

CREATE TABLE gf_travel_ledger (
  id             bigserial PRIMARY KEY,
  department_id  bigint NOT NULL REFERENCES departments (id),
  month          date NOT NULL CHECK (extract(day FROM month) = 1),
  kind           text NOT NULL CHECK (kind IN ('freeze', 'unfreeze', 'use')),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  doc_id         bigint NOT NULL REFERENCES gf_docs (id),
  op_key         text NOT NULL UNIQUE,
  created_by     bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gf_travel_ledger_dept_idx ON gf_travel_ledger (department_id, month);
CREATE TRIGGER gf_travel_ledger_append_only BEFORE UPDATE OR DELETE ON gf_travel_ledger FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE gf_licenses (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  kind        text NOT NULL CHECK (kind IN ('electronic', 'paper')),
  entity_id   bigint REFERENCES legal_entities (id),
  active      boolean NOT NULL DEFAULT true,
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gf_license_loans (
  id           bigserial PRIMARY KEY,
  license_id   bigint NOT NULL REFERENCES gf_licenses (id),
  doc_id       bigint NOT NULL UNIQUE REFERENCES gf_docs (id),
  borrower_id  bigint NOT NULL REFERENCES staff (id),
  lent_by      bigint NOT NULL REFERENCES staff (id),
  lent_at      timestamptz NOT NULL DEFAULT now(),
  due_on       date NOT NULL,
  returned_at  timestamptz,
  returned_to  bigint REFERENCES staff (id),
  CHECK ((returned_at IS NULL) = (returned_to IS NULL))
);
CREATE UNIQUE INDEX gf_license_loans_open_uq ON gf_license_loans (license_id) WHERE returned_at IS NULL;
