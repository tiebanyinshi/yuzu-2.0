-- 8.1.42 备用金合并（店主 2026-11-25：「零采备用金和备用金重复了……以后只有一个备用金」；设计与口径见 docs/V8142_PETTY.md）。
-- 以后只有部门备用金一种：原来 8.1.9 的零采备用金（182）并进来——
--   · 申用（LC）记在部门的备用金上：petty_pool_uses 改名 petty_uses、加 department_id；报销单 ↔ 申用 改名 expense_claim_petty_uses；
--   · 报销单的「钱从哪来」不再有 pool：原来 pool 的报销单改成 petty，挂在迁移给这个部门登记的一笔「并入打款」上
--     （金额 = 零采备用金的总额〔只给归属部门〕+ 这个部门已确认的零采报销合计——确认那一刻公司已经回补过，所以余额不变）；
--     没法挂打款的（金额算出来是 0：没配总额、也没有已确认的）改成「公司直付」；
--   · 零采备用金的总额加进归属部门的定额（petty_accounts.limit_cents）；
--   · 权限 pool.read / pool.manage 并成 petty.use（备用金申用）：岗位建议权限、后台岗位权限、个人微调一起改，每个岗位记一条配置日志；
--   · 操作编号与「确认作废」加业务类型 petty_use（旧的 pool_use 记录只追加、留着）；单号计数 petty_pool_use 改名 petty_use，LC 单号接着编；
--   · ERP 模块开关里的 pettyPool 去掉（模块没了，页面并进「费用与备用金」）。
-- 怎么并的逐个部门记在 petty_merge_log（只追加），回滚与对账都按它。settings.petty_pool 原样留着只作历史，代码不再读。
-- 对账（tests/upgrade-petty-merge.test.ts 核对）：各部门备用金余额 = 原余额 + 并入的总额；可用 = 原余额 + 零采的剩余可用；
-- 报销单的张数、金额、状态一张不变；申用一笔不少。
-- 回滚：docs/rollback/340_petty_merge.down.sql。

-- ───────────── 1. 改名：申用与报销单的关联 ─────────────
-- 风险已知：只改名，数据一行不动；回滚脚本改回旧名（旧版本代码按旧名读）
ALTER TABLE IF EXISTS petty_pool_uses RENAME TO petty_uses;
-- 风险已知：只改名，数据一行不动；回滚脚本改回旧名
ALTER TABLE IF EXISTS expense_claim_pool_uses RENAME TO expense_claim_petty_uses;
-- 风险已知：只改名（序列、约束、索引、触发器跟着表名走），回滚脚本改回旧名
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('petty_pool_uses_id_seq') IS NOT NULL THEN ALTER SEQUENCE petty_pool_uses_id_seq RENAME TO petty_uses_id_seq; END IF;
  FOR r IN SELECT conname, conrelid::regclass::text AS tbl FROM pg_constraint
           WHERE conrelid IN ('petty_uses'::regclass, 'expense_claim_petty_uses'::regclass) AND (conname LIKE 'petty\_pool\_uses%' OR conname LIKE 'expense\_claim\_pool\_uses%') LOOP
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.conname,
      replace(replace(r.conname, 'petty_pool_uses', 'petty_uses'), 'expense_claim_pool_uses', 'expense_claim_petty_uses'));
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
           WHERE i.indrelid IN ('petty_uses'::regclass, 'expense_claim_petty_uses'::regclass) AND (c.relname LIKE 'petty\_pool\_uses%' OR c.relname LIKE 'expense\_claim\_pool\_uses%') LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.relname,
      replace(replace(r.relname, 'petty_pool_uses', 'petty_uses'), 'expense_claim_pool_uses', 'expense_claim_petty_uses'));
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'expense_claim_pool_uses_immutable') THEN
    ALTER TRIGGER expense_claim_pool_uses_immutable ON expense_claim_petty_uses RENAME TO expense_claim_petty_uses_immutable;
  END IF;
END $$;

-- 申用记在哪个部门的备用金上（下面按数据补上，之后不能为空）
ALTER TABLE petty_uses ADD COLUMN IF NOT EXISTS department_id bigint REFERENCES departments (id);

-- ───────────── 2. 并的记录（只追加） ─────────────
CREATE TABLE IF NOT EXISTS petty_merge_log (
  department_id      bigint PRIMARY KEY REFERENCES departments (id),
  -- 迁移给这个部门登记的「并入打款」；没有的为空（这个部门的零采报销改成了公司直付）
  advance_id         bigint REFERENCES petty_advances (id),
  -- 零采备用金的总额（只记在归属部门那一行）与原来的设置
  pool_total_cents   bigint NOT NULL DEFAULT 0,
  pool_settings      jsonb,
  -- 这个部门已确认的零采报销合计（并入打款里包含它）
  confirmed_cents    bigint NOT NULL DEFAULT 0,
  -- 改成「备用金」的、改成「公司直付」的零采报销单
  petty_claim_ids    bigint[] NOT NULL DEFAULT '{}',
  company_claim_ids  bigint[] NOT NULL DEFAULT '{}',
  -- 记到这个部门的申用笔数、并之前的定额（回滚改回去）
  uses               integer NOT NULL DEFAULT 0,
  limit_before_cents bigint,
  had_account        boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS petty_merge_log_immutable ON petty_merge_log;
CREATE TRIGGER petty_merge_log_immutable BEFORE UPDATE OR DELETE ON petty_merge_log FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 3. 定额的上限与原来零采备用金的总额一样（1,000 万元） ─────────────
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'petty_accounts'::regclass AND contype = 'c' AND pg_get_expr(conbin, conrelid) LIKE '%limit_cents%' LOOP
    EXECUTE format('ALTER TABLE petty_accounts DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE petty_accounts ADD CONSTRAINT petty_accounts_limit_cents_check CHECK (limit_cents IS NULL OR (limit_cents > 0 AND limit_cents <= 1000000000));
END $$;

-- ───────────── 4. 操作编号与「确认作废」：备用金申用（petty_use），在当时的约束上追加（写法见 162） ─────────────
DO $$
DECLARE t text; expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
    IF expression NOT LIKE '%''petty_use''%' THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''petty_use''))', t, t || '_op_type_check', expression);
    END IF;
  END LOOP;
END $$;

-- ───────────── 5. 数据：零采备用金并进部门备用金 ─────────────
-- 风险已知：报销单只改「钱从哪来」与打款（pay_source pool → petty / company、advance_id），金额、明细、状态一概不动；
-- 守护触发器只在这一步停用、马上恢复（同一个迁移事务里）；改了哪几张记在 petty_merge_log，回滚脚本按它改回去
DO $$
DECLARE
  cfg jsonb;
  total bigint;
  pool_dept bigint;
  fallback bigint;
  e record;
  amt bigint;
  conf bigint;
  adv bigint;
  adv_date date;
  adv_no text;
  handler bigint;
  seq int;
  petty_ids bigint[];
  company_ids bigint[];
  had_acc boolean;
  limit_before bigint;
BEGIN
  SELECT value INTO cfg FROM settings WHERE key = 'petty_pool';
  total := CASE WHEN jsonb_typeof(cfg -> 'totalCents') = 'number' AND (cfg ->> 'totalCents')::numeric > 0 THEN (cfg ->> 'totalCents')::bigint END;
  pool_dept := CASE WHEN jsonb_typeof(cfg -> 'departmentId') = 'number' THEN (cfg ->> 'departmentId')::bigint END;
  IF pool_dept IS NOT NULL AND NOT EXISTS (SELECT 1 FROM departments WHERE id = pool_dept) THEN pool_dept := NULL; END IF;

  -- 什么都没用过（新装的店、没开过零采备用金）：不用并
  IF total IS NULL AND NOT EXISTS (SELECT 1 FROM petty_uses) AND NOT EXISTS (SELECT 1 FROM expense_claims WHERE pay_source = 'pool') THEN
    RETURN;
  END IF;

  -- 经办与登记人兜底：在职的店主，没有就最早的账号
  SELECT id INTO fallback FROM staff ORDER BY (role = 'owner' AND active AND NOT system) DESC, active DESC, id LIMIT 1;

  -- 归属部门（零采备用金的总额与申用记到哪个部门）：设置里的 → 零采报销单最多的部门 → 名字带「供应链」「采购」的 → 新建「供应链」
  IF pool_dept IS NULL AND (total IS NOT NULL OR EXISTS (SELECT 1 FROM petty_uses)) THEN
    SELECT department_id INTO pool_dept FROM expense_claims WHERE pay_source = 'pool' GROUP BY department_id ORDER BY count(*) DESC, department_id LIMIT 1;
    IF pool_dept IS NULL THEN
      SELECT id INTO pool_dept FROM departments WHERE name LIKE '%供应链%' OR name LIKE '%采购%' ORDER BY active DESC, id LIMIT 1;
    END IF;
    IF pool_dept IS NULL THEN
      INSERT INTO departments (name) VALUES ('供应链') RETURNING id INTO pool_dept;
    END IF;
  END IF;

  -- 申用记到哪个部门：挂着有效报销单的跟报销单的部门，其余记到归属部门
  ALTER TABLE petty_uses DISABLE TRIGGER USER;
  UPDATE petty_uses u SET department_id = coalesce((
    SELECT c.department_id FROM expense_claim_petty_uses l JOIN expense_claims c ON c.id = l.claim_id
    WHERE l.use_id = u.id AND c.status IN ('submitted', 'returned', 'confirmed') ORDER BY c.id DESC LIMIT 1), pool_dept)
  WHERE u.department_id IS NULL;
  ALTER TABLE petty_uses ENABLE TRIGGER USER;

  -- 逐个部门：有零采报销单的部门，加上归属部门（有总额时）
  ALTER TABLE expense_claims DISABLE TRIGGER expense_claims_guard;
  FOR e IN
    SELECT d AS department_id FROM (
      SELECT DISTINCT department_id AS d FROM expense_claims WHERE pay_source = 'pool'
      UNION SELECT pool_dept WHERE pool_dept IS NOT NULL AND (total IS NOT NULL OR EXISTS (SELECT 1 FROM petty_uses WHERE department_id = pool_dept))
    ) x ORDER BY d
  LOOP
    SELECT coalesce(sum(amount_cents), 0) INTO conf FROM expense_claims WHERE pay_source = 'pool' AND department_id = e.department_id AND status = 'confirmed';
    amt := conf + CASE WHEN e.department_id = pool_dept THEN coalesce(total, 0) ELSE 0 END;
    adv := NULL;
    petty_ids := '{}';
    company_ids := '{}';
    IF amt > 0 THEN
      SELECT coalesce(
        (SELECT pa.custodian_id FROM petty_accounts pa JOIN staff s ON s.id = pa.custodian_id WHERE pa.department_id = e.department_id),
        (SELECT handler_id FROM expense_claims WHERE pay_source = 'pool' AND department_id = e.department_id ORDER BY expense_date, id LIMIT 1),
        (SELECT applicant_id FROM petty_uses WHERE department_id = e.department_id ORDER BY use_date, id LIMIT 1),
        fallback) INTO handler;
      adv_date := least(
        coalesce((SELECT min(expense_date) FROM expense_claims WHERE pay_source = 'pool' AND department_id = e.department_id), current_date),
        coalesce((SELECT min(use_date) FROM petty_uses WHERE department_id = e.department_id), current_date),
        current_date);
      INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES ('petty_advance', adv_date, 1)
      ON CONFLICT (doc_type, business_date) DO UPDATE SET last_no = doc_counters.last_no + 1 RETURNING last_no INTO seq;
      adv_no := 'BY' || to_char(adv_date, 'YYYYMMDD') || '-' || lpad(seq::text, 4, '0');
      INSERT INTO petty_advances (doc_no, department_id, handler_id, advance_date, amount_cents, method, evidence, note, created_by)
      VALUES (adv_no, e.department_id, handler, adv_date, amt, 'other', '零采备用金并入备用金（8.1.42 迁移 340）',
              format('并入：零采备用金总额 %s 分 + 已确认的零采报销 %s 分（确认时已由公司回补）', CASE WHEN e.department_id = pool_dept THEN coalesce(total, 0) ELSE 0 END, conf),
              fallback)
      RETURNING id INTO adv;
      SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO petty_ids FROM expense_claims WHERE pay_source = 'pool' AND department_id = e.department_id;
      UPDATE expense_claims SET pay_source = 'petty', advance_id = adv WHERE pay_source = 'pool' AND department_id = e.department_id;
    ELSE
      SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO company_ids FROM expense_claims WHERE pay_source = 'pool' AND department_id = e.department_id;
      UPDATE expense_claims SET pay_source = 'company' WHERE pay_source = 'pool' AND department_id = e.department_id;
    END IF;

    -- 总额加进归属部门的定额（原来有定额的加在一起：两份备用金并成一份）
    had_acc := false;
    limit_before := NULL;
    SELECT true, limit_cents INTO had_acc, limit_before FROM petty_accounts WHERE department_id = e.department_id;
    had_acc := coalesce(had_acc, false);
    IF e.department_id = pool_dept AND total IS NOT NULL THEN
      IF NOT had_acc THEN
        INSERT INTO petty_accounts (department_id, limit_cents, note, updated_by)
        VALUES (e.department_id, least(total, 1000000000), '8.1.42 并入零采备用金（总额是定额）', fallback);
      ELSE
        UPDATE petty_accounts SET limit_cents = least(coalesce(limit_cents, 0) + total, 1000000000), version = version + 1, updated_by = fallback, updated_at = now(),
               note = CASE WHEN note = '' THEN '8.1.42 并入零采备用金（定额加上了零采的总额）' ELSE note END
        WHERE department_id = e.department_id;
      END IF;
    END IF;

    INSERT INTO petty_merge_log (department_id, advance_id, pool_total_cents, pool_settings, confirmed_cents, petty_claim_ids, company_claim_ids, uses, limit_before_cents, had_account)
    VALUES (e.department_id, adv, CASE WHEN e.department_id = pool_dept THEN coalesce(total, 0) ELSE 0 END, CASE WHEN e.department_id = pool_dept THEN cfg END,
            conf, petty_ids, company_ids, (SELECT count(*) FROM petty_uses WHERE department_id = e.department_id), limit_before, had_acc);
  END LOOP;
  ALTER TABLE expense_claims ENABLE TRIGGER expense_claims_guard;

  -- 自己核对：每笔并入打款的未平 = 并入的总额（已确认的零采报销都挂在它上面，正好抵掉）
  IF EXISTS (
    SELECT 1 FROM petty_merge_log m JOIN petty_advances a ON a.id = m.advance_id
    WHERE a.amount_cents - coalesce((SELECT sum(c.amount_cents) FROM expense_claims c WHERE c.advance_id = a.id AND c.status = 'confirmed'), 0) <> m.pool_total_cents
  ) THEN
    RAISE EXCEPTION '零采备用金并入以后对不上：并入打款的未平不等于原来的总额';
  END IF;
  IF EXISTS (SELECT 1 FROM expense_claims WHERE pay_source = 'pool') THEN RAISE EXCEPTION '还有钱从零采备用金来的报销单没并'; END IF;
END $$;

-- 风险已知：上一步每笔申用都记上了部门（没有就记到归属部门），这里才要求不为空；有空的说明上一步没跑到，整个迁移失败、不留半截
ALTER TABLE petty_uses ALTER COLUMN department_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS petty_uses_dept_idx ON petty_uses (department_id, use_date DESC, id DESC);

-- 「钱从哪来」只剩备用金、公司直付（pool 不能再写进来）
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'expense_claims'::regclass AND contype = 'c'
             AND pg_get_expr(conbin, conrelid) LIKE '%pay_source%' AND pg_get_expr(conbin, conrelid) NOT LIKE '%advance_id%' LOOP
    EXECUTE format('ALTER TABLE expense_claims DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE expense_claims ADD CONSTRAINT expense_claims_pay_source_check CHECK (pay_source IN ('petty', 'company'));
END $$;

-- 申用登记以后，单号、日期、部门、申请人、用途、内容、金额、经办都不能改，也不能删（错了作废后重新申用）
CREATE OR REPLACE FUNCTION yuzu_petty_use_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '备用金的申用不能删除，请作废'; END IF;
  IF NEW.doc_no IS DISTINCT FROM OLD.doc_no OR NEW.use_date IS DISTINCT FROM OLD.use_date OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.applicant_id IS DISTINCT FROM OLD.applicant_id OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.client_key IS DISTINCT FROM OLD.client_key OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '备用金的申用登记后内容不能修改，请作废后重新申用';
  END IF;
  IF OLD.status = 'voided' THEN RAISE EXCEPTION '已作废的申用不能再改'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS petty_pool_uses_guard ON petty_uses;
DROP TRIGGER IF EXISTS petty_uses_guard ON petty_uses;
CREATE TRIGGER petty_uses_guard BEFORE UPDATE OR DELETE ON petty_uses FOR EACH ROW EXECUTE FUNCTION yuzu_petty_use_guard();
DROP FUNCTION IF EXISTS yuzu_petty_pool_use_guard();

-- 单号计数：LC 接着原来的编（同一天不会重号）
UPDATE doc_counters SET doc_type = 'petty_use' WHERE doc_type = 'petty_pool_use';

-- ERP 模块开关：零采备用金模块没了（页面并进「费用与备用金」）
UPDATE settings SET value = value - 'pettyPool' WHERE key = 'erp_modules' AND jsonb_typeof(value) = 'object' AND value ? 'pettyPool';

-- ───────────── 6. 权限：pool.read / pool.manage 并成 petty.use（备用金申用） ─────────────
-- 一份增减（{add, remove}）：去掉 pool 的两项；原来去掉了其中哪一项的，去掉 petty.use（宁少不多）；否则原来加了的，加上 petty.use
CREATE FUNCTION pg_temp.yuzu_petty_merge_adjust(cfg jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a jsonb; r jsonb; had_a boolean; had_r boolean;
BEGIN
  IF cfg IS NULL OR jsonb_typeof(cfg) <> 'object' THEN RETURN cfg; END IF;
  a := CASE WHEN jsonb_typeof(cfg -> 'add') = 'array' THEN cfg -> 'add' END;
  r := CASE WHEN jsonb_typeof(cfg -> 'remove') = 'array' THEN cfg -> 'remove' END;
  had_a := coalesce(a ?| ARRAY['pool.read', 'pool.manage'], false);
  had_r := coalesce(r ?| ARRAY['pool.read', 'pool.manage'], false);
  IF NOT had_a AND NOT had_r THEN RETURN cfg; END IF;
  IF a IS NOT NULL THEN a := a - 'pool.read' - 'pool.manage'; END IF;
  IF r IS NOT NULL THEN r := r - 'pool.read' - 'pool.manage'; END IF;
  IF had_r THEN
    IF NOT r ? 'petty.use' THEN r := r || '["petty.use"]'::jsonb; END IF;
    IF a IS NOT NULL THEN a := a - 'petty.use'; END IF;
  ELSIF NOT a ? 'petty.use' THEN
    a := a || '["petty.use"]'::jsonb;
  END IF;
  IF a IS NOT NULL THEN cfg := jsonb_set(cfg, '{add}', a); END IF;
  IF r IS NOT NULL THEN cfg := jsonb_set(cfg, '{remove}', r); END IF;
  RETURN cfg;
END $$;

-- 后台「岗位权限」（旧岗位、新岗位两份）
UPDATE settings s SET value = (SELECT jsonb_object_agg(e.k, pg_temp.yuzu_petty_merge_adjust(e.v)) FROM jsonb_each(s.value) AS e(k, v))
WHERE s.key IN ('role_permissions', 'position_permissions') AND jsonb_typeof(s.value) = 'object' AND s.value <> '{}'::jsonb AND s.value::text LIKE '%"pool.%';
-- 员工档案里的个人微调
UPDATE staff SET permission_adjust = pg_temp.yuzu_petty_merge_adjust(permission_adjust) WHERE permission_adjust::text LIKE '%"pool.%';

-- 岗位的建议权限（「分部门岗位职权配置」）：有 pool 两项之一的岗位换成 petty.use，每个岗位记一条配置日志（只追加）
INSERT INTO position_config_log (staff_id, action, position_key, detail)
SELECT NULL, 'suggestions', position_key,
       jsonb_build_object('added', '["petty.use"]'::jsonb, 'removed', to_jsonb(array_agg(permission ORDER BY permission)),
                          'note', '8.1.42 零采备用金并进备用金：「零采备用金」的看与办两项并成「备用金申用」（迁移 340）')
FROM position_suggestions WHERE permission IN ('pool.read', 'pool.manage') GROUP BY position_key ORDER BY position_key;
INSERT INTO position_suggestions (position_key, permission)
SELECT DISTINCT position_key, 'petty.use' FROM position_suggestions WHERE permission IN ('pool.read', 'pool.manage')
ON CONFLICT DO NOTHING;
DELETE FROM position_suggestions WHERE permission IN ('pool.read', 'pool.manage');

DROP FUNCTION pg_temp.yuzu_petty_merge_adjust(jsonb);
