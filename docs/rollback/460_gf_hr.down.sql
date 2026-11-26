-- 回滚 460_gf_hr.sql（业财法 P07）：只在没有正式数据时用；先删 HR 批次事项再收紧类型约束
DROP TABLE IF EXISTS gf_alloc_runs;
DROP TABLE IF EXISTS gf_alloc_rule_versions;
DROP TABLE IF EXISTS gf_alloc_rules;
DROP TABLE IF EXISTS gf_hr_payouts;
DROP TABLE IF EXISTS gf_hr_checks;
DROP TABLE IF EXISTS gf_hr_batch_lines;
DROP TABLE IF EXISTS gf_hr_batches;
ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check
  CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change', 'petty_purchase', 'quota_adjust', 'contract', 'payment',
                      'expense', 'travel', 'entertain', 'seal_use'));
