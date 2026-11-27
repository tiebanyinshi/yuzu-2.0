-- 回滚 530_cashier_v821.sql（8.2.1 批 1 收银台：单项打折、手牌押金）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 会丢掉：单项打折的记录与结账单上的「单项折扣」收款（结账单的应收不变，已结的单优惠少记这一笔，部门营业额快照不重算）、
-- 手牌押金台账（押着的押金先在页面上退完再回滚；储值扣的押金退回原卡的撤销单留在会员钱包里）。
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tag_deposits WHERE status = 'held') THEN
    RAISE EXCEPTION '还有押着的手牌押金，请先在收银台或发卡台退完再回滚';
  END IF;
END $$;
ALTER TABLE idempotency_keys DISABLE TRIGGER idempotency_keys_append_only;
DELETE FROM idempotency_keys WHERE op_type IN ('line_discount', 'tag_deposit', 'tag_deposit_refund');
ALTER TABLE idempotency_keys ENABLE TRIGGER idempotency_keys_append_only;
ALTER TABLE op_fences DISABLE TRIGGER op_fences_append_only;
DELETE FROM op_fences WHERE op_type IN ('line_discount', 'tag_deposit', 'tag_deposit_refund');
ALTER TABLE op_fences ENABLE TRIGGER op_fences_append_only;
ALTER TABLE checkout_payments DISABLE TRIGGER checkout_payments_append_only;
DELETE FROM checkout_payments WHERE method = 'line_discount';
ALTER TABLE checkout_payments ENABLE TRIGGER checkout_payments_append_only;
DO $$
DECLARE
  t text;
  expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NOT NULL THEN
      expression := replace(expression, ' OR (op_type = ANY (ARRAY[''line_discount''::text, ''tag_deposit''::text, ''tag_deposit_refund''::text]))', '');
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', t, t || '_op_type_check', expression);
    END IF;
  END LOOP;
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'checkout_payments'::regclass AND conname = 'checkout_payments_method_check';
  expression := replace(expression, ' OR (method = ''line_discount''::text)', '');
  ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_method_check;
  EXECUTE format('ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_method_check CHECK (%s)', expression);
  -- 授权用途：去掉 530 追加的「单项打折」（先删掉这一类的授权凭据，旧版本不签发这一类）
  DELETE FROM auth_grants WHERE purpose = 'line_discount';
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'auth_grants'::regclass AND conname = 'auth_grants_purpose_check';
  ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_purpose_check;
  EXECUTE format('ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_purpose_check CHECK (%s)', replace(expression, ' OR (purpose = ''line_discount''::text)', ''));
END $$;
DROP INDEX IF EXISTS checkout_payments_line_discount_uq;
-- 部门营业额快照的函数换回 108 版
CREATE OR REPLACE FUNCTION yuzu_snapshot_checkout_items(p_checkout bigint, p_current boolean) RETURNS void LANGUAGE sql AS $$
  WITH c AS (SELECT id, created_at FROM checkouts WHERE id = p_checkout),
  cl AS (
    SELECT coalesce((SELECT coupon_lines FROM checkout_payments
                     WHERE checkout_id = p_checkout AND method IN ('store_coupon', 'member_discount')), '{}'::bigint[]) AS ids
  ),
  l AS (
    SELECT CASE WHEN l.ticket_type_id IS NOT NULL THEN '门票'
                WHEN l.source = 'room' THEN '客房'
                WHEN uc.line_id IS NOT NULL THEN coalesce(nullif(sp.business_type, ''), '派对房')
                WHEN l.item_id IS NULL THEN '其他（手动金额、赔偿等）'
                ELSE coalesce(nullif(si.category, ''), '未分类') END AS category,
           CASE WHEN rc.kind = 'night' THEN '房费（全天房）' WHEN rc.kind = 'half_day' THEN '超时半天' WHEN rc.kind = 'block' THEN '钟点房'
                WHEN uc.kind = 'fee' THEN '房费' WHEN uc.kind = 'open_fee' THEN '开台费' ELSE l.name END AS name,
           l.quantity, l.amount, l.id = ANY (cl.ids) AS in_coupon
    FROM c CROSS JOIN cl JOIN checkout_bills cb ON cb.checkout_id = c.id
    JOIN bill_lines l ON l.bill_id = cb.bill_id
     AND CASE WHEN p_current THEN l.status = 'active'
              ELSE l.posted_at <= c.created_at AND (l.voided_at IS NULL OR l.voided_at > c.created_at) END
    LEFT JOIN service_items si ON si.id = l.item_id
    LEFT JOIN room_stay_charges rc ON rc.line_id = l.id
    LEFT JOIN space_usage_charges uc ON uc.line_id = l.id
    LEFT JOIN space_usages su ON su.id = uc.usage_id
    LEFT JOIN spaces sp ON sp.id = su.space_id
  ),
  r AS (
    SELECT category, name, sum(quantity)::int AS quantity, sum(amount)::bigint AS amount,
           coalesce(sum(amount) FILTER (WHERE in_coupon), 0)::bigint AS coupon_base
    FROM l GROUP BY 1, 2
  ),
  d AS (
    SELECT coalesce(sum(amount) FILTER (WHERE method = 'discount'), 0)::bigint AS disc,
           coalesce(sum(amount) FILTER (WHERE method IN ('store_coupon', 'member_discount')), 0)::bigint AS coup
    FROM checkout_payments WHERE checkout_id = p_checkout
  ),
  t AS (SELECT coalesce(sum(amount), 0)::bigint AS total, coalesce(sum(coupon_base), 0)::bigint AS coupon_total FROM r),
  b AS (
    SELECT r.category, r.name, r.quantity, r.amount, r.coupon_base,
           CASE WHEN t.total > 0 THEN (r.amount * d.disc) / t.total ELSE 0 END AS share,
           CASE WHEN t.total > 0 THEN (r.amount * d.disc) % t.total ELSE 0 END AS frac,
           CASE WHEN t.coupon_total > 0 THEN (r.coupon_base * d.coup) / t.coupon_total ELSE 0 END AS cshare,
           CASE WHEN t.coupon_total > 0 THEN (r.coupon_base * d.coup) % t.coupon_total ELSE 0 END AS cfrac
    FROM r, d, t
  ),
  ranked AS (
    SELECT b.*,
           row_number() OVER (ORDER BY b.frac DESC, b.amount DESC, b.category COLLATE "C", b.name COLLATE "C") AS rn,
           row_number() OVER (ORDER BY b.cfrac DESC, b.coupon_base DESC, b.category COLLATE "C", b.name COLLATE "C") AS crn
    FROM b
  ),
  left_over AS (
    SELECT d.disc - coalesce((SELECT sum(share) FROM b), 0) AS n,
           d.coup - coalesce((SELECT sum(cshare) FROM b), 0) AS cn
    FROM d
  )
  INSERT INTO checkout_items (checkout_id, category, name, quantity, amount, discount)
  SELECT p_checkout, x.category, x.name, x.quantity, x.amount,
         x.share + CASE WHEN x.rn <= lo.n THEN 1 ELSE 0 END
         + x.cshare + CASE WHEN x.crn <= lo.cn AND x.coupon_base > 0 THEN 1 ELSE 0 END
  FROM ranked x, left_over lo
$$;
DROP TABLE tag_deposits;
DROP FUNCTION yuzu_tag_deposit_guard();
DROP TABLE bill_line_discounts;
DROP FUNCTION yuzu_line_discount_guard();
DELETE FROM schema_migrations WHERE version = '530_cashier_v821.sql';
COMMIT;
