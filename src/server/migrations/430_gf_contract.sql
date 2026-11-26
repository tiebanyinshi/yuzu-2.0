-- 430 业财法 P04：七类合同审批（docs/APPROVAL_V4.md 第 8 节）。
--   · gf_docs 的事项类型加 contract（合同；合同号、类型、金额口径、经济实质、明细都在 payload）；
--   · gf_contract_versions：合同的版本（只追加）：初版、只减金额的变更（保留原审批）、核心变更重新路由（原审批作废，指向新事项）。

DO $$
BEGIN
  ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
  ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check
    CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change', 'petty_purchase', 'quota_adjust', 'contract'));
END $$;

CREATE TABLE gf_contract_versions (
  id            bigserial PRIMARY KEY,
  doc_id        bigint NOT NULL REFERENCES gf_docs (id),
  version       integer NOT NULL CHECK (version >= 1),
  kind          text NOT NULL CHECK (kind IN ('initial', 'decrease', 'reroute')),
  approval_cents bigint NOT NULL CHECK (approval_cents >= 0),
  fields        text[] NOT NULL DEFAULT '{}',
  reason        text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 300),
  -- 核心变更重新路由的新事项
  new_doc_id    bigint REFERENCES gf_docs (id),
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, version)
);
CREATE TRIGGER gf_contract_versions_append_only BEFORE UPDATE OR DELETE ON gf_contract_versions FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
