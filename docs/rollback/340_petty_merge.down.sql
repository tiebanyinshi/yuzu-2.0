-- 回滚 340_petty_merge.sql（8.1.42 零采备用金并进备用金）。先停服务、先备份；只在回到 8.1.42 以前的版本时执行。
-- 按 petty_merge_log 改回去：报销单的「钱从哪来」改回零采备用金（pool）、去掉迁移登记的并入打款、定额改回原来的、
-- 申用表与关联表改回旧名、权限改回 pool.read / pool.manage。
-- 升级以后新登记的申用（不在零采备用金的归属部门的）回滚后都算进零采备用金；之后新登记的「备用金」报销单勾了申用的，
-- 旧版本只认零采备用金的报销单挂申用，账目自检会报出来，要人工处理（先冲销、按旧版本重新登记）。
-- 并入打款上要是后来又登记了报销、退回或补付，回滚会失败（外键）：先把那几张冲销、记下来，回滚后按旧版本重新登记。
BEGIN;

-- 0. 并的记录先拿出来（只追加的表，整张删掉；并入打款被它引用着，删打款之前先删它）
CREATE TEMP TABLE m340 ON COMMIT DROP AS SELECT * FROM petty_merge_log;
DROP TABLE petty_merge_log;

-- 1. 报销单改回零采备用金
ALTER TABLE expense_claims DISABLE TRIGGER expense_claims_guard;
ALTER TABLE expense_claims DROP CONSTRAINT expense_claims_pay_source_check;
ALTER TABLE expense_claims ADD CONSTRAINT expense_claims_pay_source_check CHECK (pay_source IN ('petty', 'company') OR pay_source = 'pool');
UPDATE expense_claims c SET pay_source = 'pool', advance_id = NULL
FROM m340 m WHERE c.id = ANY (m.petty_claim_ids || m.company_claim_ids);
ALTER TABLE expense_claims ENABLE TRIGGER expense_claims_guard;

-- 2. 去掉并入打款（打款守护不许删，这一步停用、马上恢复）
ALTER TABLE petty_advances DISABLE TRIGGER petty_advances_guard;
DELETE FROM petty_advances a USING m340 m WHERE a.id = m.advance_id;
ALTER TABLE petty_advances ENABLE TRIGGER petty_advances_guard;

-- 3. 定额改回原来的（原来没有设置的删掉那一行）
UPDATE petty_accounts pa SET limit_cents = m.limit_before_cents, version = pa.version + 1, updated_at = now()
FROM m340 m WHERE pa.department_id = m.department_id AND m.pool_total_cents > 0 AND m.had_account;
DELETE FROM petty_accounts pa USING m340 m WHERE pa.department_id = m.department_id AND m.pool_total_cents > 0 AND NOT m.had_account;
ALTER TABLE petty_accounts DROP CONSTRAINT petty_accounts_limit_cents_check;
ALTER TABLE petty_accounts ADD CONSTRAINT petty_accounts_limit_cents_check CHECK (limit_cents IS NULL OR (limit_cents > 0 AND limit_cents <= 100000000));

-- 4. 申用：去掉部门一列、换回旧的守护、改回旧名
DROP TRIGGER petty_uses_guard ON petty_uses;
DROP FUNCTION yuzu_petty_use_guard();
DROP INDEX petty_uses_dept_idx;
ALTER TABLE petty_uses DROP COLUMN department_id;
ALTER TABLE petty_uses RENAME TO petty_pool_uses;
ALTER SEQUENCE petty_uses_id_seq RENAME TO petty_pool_uses_id_seq;
ALTER TABLE petty_pool_uses RENAME CONSTRAINT petty_uses_pkey TO petty_pool_uses_pkey;
ALTER TABLE petty_pool_uses RENAME CONSTRAINT petty_uses_doc_no_key TO petty_pool_uses_doc_no_key;
ALTER TABLE petty_pool_uses RENAME CONSTRAINT petty_uses_client_key_key TO petty_pool_uses_client_key_key;
ALTER INDEX petty_uses_date_idx RENAME TO petty_pool_uses_date_idx;
ALTER INDEX petty_uses_open_idx RENAME TO petty_pool_uses_open_idx;
ALTER INDEX petty_uses_po_idx RENAME TO petty_pool_uses_po_idx;
CREATE FUNCTION yuzu_petty_pool_use_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '零采备用金的申用不能删除，请作废'; END IF;
  IF NEW.doc_no IS DISTINCT FROM OLD.doc_no OR NEW.use_date IS DISTINCT FROM OLD.use_date OR NEW.applicant_id IS DISTINCT FROM OLD.applicant_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.content IS DISTINCT FROM OLD.content OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.client_key IS DISTINCT FROM OLD.client_key OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '零采备用金的申用登记后内容不能修改，请作废后重新申用';
  END IF;
  IF OLD.status = 'voided' THEN RAISE EXCEPTION '已作废的申用不能再改'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER petty_pool_uses_guard BEFORE UPDATE OR DELETE ON petty_pool_uses FOR EACH ROW EXECUTE FUNCTION yuzu_petty_pool_use_guard();
ALTER TABLE expense_claim_petty_uses RENAME TO expense_claim_pool_uses;
ALTER TABLE expense_claim_pool_uses RENAME CONSTRAINT expense_claim_petty_uses_pkey TO expense_claim_pool_uses_pkey;
ALTER INDEX expense_claim_petty_uses_use_idx RENAME TO expense_claim_pool_uses_use_idx;
ALTER TRIGGER expense_claim_petty_uses_immutable ON expense_claim_pool_uses RENAME TO expense_claim_pool_uses_immutable;
UPDATE doc_counters SET doc_type = 'petty_pool_use' WHERE doc_type = 'petty_use';

-- 5. 权限改回：有 petty.use 的岗位建议权限换回 pool.read、pool.manage（后台岗位权限、个人微调里的 petty.use 旧版本不认识，留着不生效）
INSERT INTO position_suggestions (position_key, permission)
SELECT position_key, p FROM position_suggestions, unnest(ARRAY['pool.read', 'pool.manage']) AS p WHERE permission = 'petty.use'
ON CONFLICT DO NOTHING;
DELETE FROM position_suggestions WHERE permission = 'petty.use';

-- 操作编号类型约束里的 petty_use 留着不碍事
DELETE FROM schema_migrations WHERE version = '340_petty_merge.sql';
COMMIT;
