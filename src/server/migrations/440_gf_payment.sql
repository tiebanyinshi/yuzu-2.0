-- 440 业财法 P05：付款与紧急特批（docs/APPROVAL_V4.md 第 9 节）。
--   · gf_docs 的事项类型加 payment（付款申请，含税金额；合同、付款节点、验收依据、发票、收款账户快照都在 payload）；
--   · gf_payouts：出纳的付款记录（只追加）：银行流水号唯一，同一付款申请可以分次，累计不超过申请金额；
--   · gf_specials 加 payee_account：紧急特批确认时的收款账户（换账户要重新特批）。

DO $$
BEGIN
  ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
  ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check
    CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change', 'petty_purchase', 'quota_adjust', 'contract', 'payment'));
END $$;

ALTER TABLE gf_specials ADD COLUMN payee_account text CHECK (payee_account ~ '^[0-9]{6,30}$');

CREATE TABLE gf_payouts (
  id             bigserial PRIMARY KEY,
  doc_id         bigint NOT NULL REFERENCES gf_docs (id),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  payee_account  text NOT NULL,
  bank_ref       text NOT NULL UNIQUE CHECK (char_length(bank_ref) BETWEEN 4 AND 60),
  client_key     uuid NOT NULL UNIQUE,
  paid_by        bigint NOT NULL REFERENCES staff (id),
  paid_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gf_payouts_doc_idx ON gf_payouts (doc_id);
CREATE TRIGGER gf_payouts_append_only BEFORE UPDATE OR DELETE ON gf_payouts FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
