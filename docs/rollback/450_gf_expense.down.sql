-- 回滚 450_gf_expense.sql（业财法 P06）：只在没有正式数据时用；先删 P06 的事项再收紧类型约束
DROP TABLE IF EXISTS gf_license_loans;
DROP TABLE IF EXISTS gf_licenses;
DROP TABLE IF EXISTS gf_travel_ledger;
DROP TABLE IF EXISTS gf_travel_budgets;
ALTER TABLE gf_docs DROP CONSTRAINT gf_docs_doc_type_check;
ALTER TABLE gf_docs ADD CONSTRAINT gf_docs_doc_type_check
  CHECK (doc_type IN ('general', 'supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change', 'petty_purchase', 'quota_adjust', 'contract', 'payment'));
