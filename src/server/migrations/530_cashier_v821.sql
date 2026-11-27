-- 8.2.1 批 1：收银台（店主 2026-11-26 两份会议纪要「收银系统功能评审」「会所管理系统演示」；设计见 docs/V8221_CASHIER.md）。
--   ① 单项打折：账单的一行按折扣或折后价打折，按岗位的下限，超了要当场授权；结账时折掉的钱记一笔「单项折扣」（不是收款），
--      部门营业额快照按行分摊到那一行；
--   ② 手牌押金：客人外出留牌、去别的区域时收押金（现金、微信、支付宝、银行卡，或从会员储值扣），一键退，结账时一起退掉抵扣。
-- 风险已知：只加表、加约束里的取值、换部门营业额快照的函数（已有的结账单没有单项折扣，算出来与原来一样）；
-- 回滚见 docs/rollback/530_cashier_v821.down.sql。

-- ───────────── ① 单项打折 ─────────────
CREATE TABLE bill_line_discounts (
  id             bigserial PRIMARY KEY,
  line_id        bigint NOT NULL REFERENCES bill_lines (id),
  bill_id        bigint NOT NULL REFERENCES bills (id),
  list_amount    bigint NOT NULL CHECK (list_amount > 0),
  final_amount   bigint NOT NULL CHECK (final_amount >= 0),
  rate           smallint CHECK (rate BETWEEN 0 AND 99),
  reason         text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 64),
  tier           text NOT NULL CHECK (tier IN ('cashier', 'duty', 'lead', 'owner')),
  floor_pct      smallint NOT NULL CHECK (floor_pct BETWEEN 0 AND 100),
  staff_id       bigint NOT NULL REFERENCES staff (id),
  approved_by    bigint REFERENCES staff (id),
  grant_id       uuid REFERENCES auth_grants (id),
  client_key     uuid NOT NULL UNIQUE,
  business_date  date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_by     bigint REFERENCES staff (id),
  revoked_at     timestamptz,
  revoke_reason  text CHECK (char_length(revoke_reason) BETWEEN 2 AND 64),
  CHECK (final_amount < list_amount),
  CHECK ((approved_by IS NULL) = (grant_id IS NULL)),
  CHECK ((status = 'revoked') = (revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);
-- 一行同时只有一个有效的折扣（改折扣 = 撤下原来的、记一条新的，同一个事务）
CREATE UNIQUE INDEX bill_line_discounts_active_uq ON bill_line_discounts (line_id) WHERE status = 'active';
CREATE INDEX bill_line_discounts_line_idx ON bill_line_discounts (line_id, id);
CREATE INDEX bill_line_discounts_bill_idx ON bill_line_discounts (bill_id, id);
CREATE UNIQUE INDEX bill_line_discounts_grant_uq ON bill_line_discounts (grant_id) WHERE grant_id IS NOT NULL;
COMMENT ON TABLE bill_line_discounts IS '单项打折（8.2.1）：账单的一行打折；金额单位分。明细本身不改，折掉的钱结账时记一笔「单项折扣」；只能撤下、不能改';
COMMENT ON COLUMN bill_line_discounts.line_id IS '打折的那一行明细';
COMMENT ON COLUMN bill_line_discounts.bill_id IS '明细所在的账单（结账时按账单汇总）';
COMMENT ON COLUMN bill_line_discounts.list_amount IS '打折前这一行的金额（分，= 明细金额）';
COMMENT ON COLUMN bill_line_discounts.final_amount IS '折后这一行收多少（分）；0 = 这一行免单';
COMMENT ON COLUMN bill_line_discounts.rate IS '按折扣打的：收原价的百分之几（80 = 八折，0 = 免单）；按折后价填的为空';
COMMENT ON COLUMN bill_line_discounts.reason IS '打折的原因（选填）';
COMMENT ON COLUMN bill_line_discounts.tier IS '打折人当时的折扣档：cashier 前台收银 / duty 值班经理 / lead 部门负责人、店总 / owner 店主';
COMMENT ON COLUMN bill_line_discounts.floor_pct IS '打折人当时那一档的下限（收原价的百分之几）；超了要当场授权';
COMMENT ON COLUMN bill_line_discounts.staff_id IS '打折的人';
COMMENT ON COLUMN bill_line_discounts.approved_by IS '超过打折人下限时当场授权的人；没超的为空';
COMMENT ON COLUMN bill_line_discounts.grant_id IS '当场授权的编号（只能用一次）';
COMMENT ON COLUMN bill_line_discounts.client_key IS '操作编号（同一编号只记一次）';
COMMENT ON COLUMN bill_line_discounts.business_date IS '营业日';
COMMENT ON COLUMN bill_line_discounts.created_at IS '打折的时间';
COMMENT ON COLUMN bill_line_discounts.status IS 'active 有效 / revoked 已撤下（恢复原价或改了别的折扣）';
COMMENT ON COLUMN bill_line_discounts.revoked_by IS '撤下的人';
COMMENT ON COLUMN bill_line_discounts.revoked_at IS '撤下的时间';
COMMENT ON COLUMN bill_line_discounts.revoke_reason IS '撤下的原因';

CREATE FUNCTION yuzu_line_discount_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bill_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '单项打折记录禁止删除，请撤下并填写原因' USING ERRCODE = 'P0001';
  END IF;
  SELECT status INTO bill_status FROM bills WHERE id = NEW.bill_id;
  IF bill_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION '账单已结束，不能再打折或撤下折扣' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION '新记的折扣必须是有效状态' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'revoked'
     AND (NEW.id, NEW.line_id, NEW.bill_id, NEW.list_amount, NEW.final_amount, NEW.rate, NEW.reason, NEW.tier, NEW.floor_pct,
          NEW.staff_id, NEW.approved_by, NEW.grant_id, NEW.client_key, NEW.business_date, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.line_id, OLD.bill_id, OLD.list_amount, OLD.final_amount, OLD.rate, OLD.reason, OLD.tier, OLD.floor_pct,
          OLD.staff_id, OLD.approved_by, OLD.grant_id, OLD.client_key, OLD.business_date, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '单项打折只能撤下，不能修改' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER bill_line_discounts_guard BEFORE INSERT OR UPDATE OR DELETE ON bill_line_discounts
  FOR EACH ROW EXECUTE FUNCTION yuzu_line_discount_guard();

-- 结账收款加「单项折扣」：优惠、不是收款（与会员折扣同一口径）；结账时按这几张账单上有效的折扣合计记一笔
DO $$
DECLARE
  expression text;
  t text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression
  FROM pg_constraint WHERE conrelid = 'checkout_payments'::regclass AND conname = 'checkout_payments_method_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原收款方式约束不存在'; END IF;
  ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_method_check;
  EXECUTE format('ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_method_check CHECK ((%s) OR method = ''line_discount'')', expression);

  SELECT pg_get_expr(conbin, conrelid) INTO expression
  FROM pg_constraint WHERE conrelid = 'auth_grants'::regclass AND conname = 'auth_grants_purpose_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原授权用途约束不存在'; END IF;
  ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_purpose_check;
  EXECUTE format('ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_purpose_check CHECK ((%s) OR purpose = ''line_discount'')', expression);

  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression
    FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type = ANY (ARRAY[''line_discount''::text, ''tag_deposit''::text, ''tag_deposit_refund''::text]))',
                   t, t || '_op_type_check', expression);
  END LOOP;
END $$;
CREATE UNIQUE INDEX checkout_payments_line_discount_uq ON checkout_payments (checkout_id) WHERE method = 'line_discount';

-- 部门营业额快照：单项折扣按行记到那一行所在的部门与项目；整单的优惠 / 免单按折后的金额比例分摊（其余与 108 版相同）
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
           l.quantity, l.amount, l.id = ANY (cl.ids) AS in_coupon,
           coalesce((SELECT d.list_amount - d.final_amount FROM bill_line_discounts d
                     WHERE d.line_id = l.id
                       AND CASE WHEN p_current THEN d.status = 'active'
                                ELSE d.created_at <= c.created_at AND (d.revoked_at IS NULL OR d.revoked_at > c.created_at) END
                     ORDER BY d.id DESC LIMIT 1), 0) AS ld
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
    SELECT category, name, sum(quantity)::int AS quantity, sum(amount)::bigint AS amount, sum(ld)::bigint AS ld,
           coalesce(sum(amount) FILTER (WHERE in_coupon), 0)::bigint AS coupon_base
    FROM l GROUP BY 1, 2
  ),
  d AS (
    SELECT coalesce(sum(amount) FILTER (WHERE method = 'discount'), 0)::bigint AS disc,
           coalesce(sum(amount) FILTER (WHERE method IN ('store_coupon', 'member_discount')), 0)::bigint AS coup
    FROM checkout_payments WHERE checkout_id = p_checkout
  ),
  t AS (SELECT coalesce(sum(amount - ld), 0)::bigint AS total, coalesce(sum(coupon_base), 0)::bigint AS coupon_total FROM r),
  b AS (
    SELECT r.category, r.name, r.quantity, r.amount, r.ld, r.coupon_base,
           CASE WHEN t.total > 0 THEN ((r.amount - r.ld) * d.disc) / t.total ELSE 0 END AS share,
           CASE WHEN t.total > 0 THEN ((r.amount - r.ld) * d.disc) % t.total ELSE 0 END AS frac,
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
         x.ld
         + x.share + CASE WHEN x.rn <= lo.n THEN 1 ELSE 0 END
         + x.cshare + CASE WHEN x.crn <= lo.cn AND x.coupon_base > 0 THEN 1 ELSE 0 END
  FROM ranked x, left_over lo
$$;

-- ───────────── ② 手牌押金 ─────────────
CREATE TABLE tag_deposits (
  id                    bigserial PRIMARY KEY,
  store_id              bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  deposit_no            text NOT NULL UNIQUE,
  visit_id              bigint NOT NULL REFERENCES visits (id),
  method                text NOT NULL CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'wallet')),
  amount                bigint NOT NULL CHECK (amount > 0),
  member_id             bigint REFERENCES members (id),
  consumption_id        bigint UNIQUE REFERENCES consumptions (id),
  reason                text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 64),
  ref                   text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 64),
  client_key            uuid NOT NULL UNIQUE,
  shift_id              bigint REFERENCES shifts (id),
  business_date         date NOT NULL,
  staff_id              bigint NOT NULL REFERENCES staff (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'refunded')),
  refund_kind           text CHECK (refund_kind IN ('manual', 'checkout', 'cancel')),
  refund_shift_id       bigint REFERENCES shifts (id),
  refund_business_date  date,
  refunded_by           bigint REFERENCES staff (id),
  refunded_at           timestamptz,
  refund_reversal_id    bigint UNIQUE REFERENCES reversals (id),
  checkout_id           bigint REFERENCES checkouts (id),
  CHECK ((method = 'wallet') = (member_id IS NOT NULL) AND (method = 'wallet') = (consumption_id IS NOT NULL)),
  CHECK ((status = 'refunded') = (refund_kind IS NOT NULL AND refund_business_date IS NOT NULL AND refunded_by IS NOT NULL AND refunded_at IS NOT NULL)),
  CHECK (method <> 'wallet' OR (status = 'refunded') = (refund_reversal_id IS NOT NULL)),
  CHECK (method = 'wallet' OR refund_reversal_id IS NULL),
  CHECK ((refund_kind IS NOT DISTINCT FROM 'checkout') = (checkout_id IS NOT NULL))
);
CREATE INDEX tag_deposits_visit_idx ON tag_deposits (visit_id, id);
CREATE INDEX tag_deposits_member_idx ON tag_deposits (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX tag_deposits_shift_idx ON tag_deposits (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX tag_deposits_refund_shift_idx ON tag_deposits (refund_shift_id) WHERE refund_shift_id IS NOT NULL;
CREATE INDEX tag_deposits_checkout_idx ON tag_deposits (checkout_id) WHERE checkout_id IS NOT NULL;
CREATE INDEX tag_deposits_day_idx ON tag_deposits (store_id, business_date);
COMMENT ON TABLE tag_deposits IS '手牌押金（8.2.1）：客人外出留牌、去别的区域时收的押金；金额单位分。押金是负债，不算营业额；收、退都记经办人当班的班次（现金计入交班应有现金）。会员储值扣的记一张储值消费单，退的时候按原单撤销、退回原卡。只能从押着改成已退';
COMMENT ON COLUMN tag_deposits.store_id IS '门店';
COMMENT ON COLUMN tag_deposits.deposit_no IS '押金单号（YJ…）';
COMMENT ON COLUMN tag_deposits.visit_id IS '押在哪一次来访（手牌）上；换牌后跟着来访走';
COMMENT ON COLUMN tag_deposits.method IS '收的方式：cash 现金 / wechat 微信 / alipay 支付宝 / bank_card 银行卡 / wallet 会员储值';
COMMENT ON COLUMN tag_deposits.amount IS '押金金额（分）';
COMMENT ON COLUMN tag_deposits.member_id IS '从哪位会员的储值扣的；不是储值的为空';
COMMENT ON COLUMN tag_deposits.consumption_id IS '储值扣押金的那张消费单';
COMMENT ON COLUMN tag_deposits.reason IS '为什么收押金（外出留牌、去别的区域等）';
COMMENT ON COLUMN tag_deposits.ref IS '收款备注（例如微信单号后几位）';
COMMENT ON COLUMN tag_deposits.client_key IS '收押金的操作编号';
COMMENT ON COLUMN tag_deposits.shift_id IS '收押金时经办人当班的班次';
COMMENT ON COLUMN tag_deposits.business_date IS '收押金的营业日';
COMMENT ON COLUMN tag_deposits.staff_id IS '收押金的人';
COMMENT ON COLUMN tag_deposits.created_at IS '收押金的时间';
COMMENT ON COLUMN tag_deposits.status IS 'held 押着 / refunded 已退';
COMMENT ON COLUMN tag_deposits.refund_kind IS '怎么退的：manual 一键退押金 / checkout 结账时退（抵扣）/ cancel 撤销来访时退';
COMMENT ON COLUMN tag_deposits.refund_shift_id IS '退押金时经办人当班的班次';
COMMENT ON COLUMN tag_deposits.refund_business_date IS '退押金的营业日';
COMMENT ON COLUMN tag_deposits.refunded_by IS '退押金的人';
COMMENT ON COLUMN tag_deposits.refunded_at IS '退押金的时间';
COMMENT ON COLUMN tag_deposits.refund_reversal_id IS '储值扣的押金退回原卡的那张撤销单';
COMMENT ON COLUMN tag_deposits.checkout_id IS '结账时退的：那张结账单';

CREATE FUNCTION yuzu_tag_deposit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '押金记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'held' AND NEW.status = 'refunded'
     AND (NEW.id, NEW.store_id, NEW.deposit_no, NEW.visit_id, NEW.method, NEW.amount, NEW.member_id, NEW.consumption_id, NEW.reason, NEW.ref,
          NEW.client_key, NEW.shift_id, NEW.business_date, NEW.staff_id, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.store_id, OLD.deposit_no, OLD.visit_id, OLD.method, OLD.amount, OLD.member_id, OLD.consumption_id, OLD.reason, OLD.ref,
          OLD.client_key, OLD.shift_id, OLD.business_date, OLD.staff_id, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '押金只能从押着改成已退，不能修改' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER tag_deposits_guard BEFORE UPDATE OR DELETE ON tag_deposits
  FOR EACH ROW EXECUTE FUNCTION yuzu_tag_deposit_guard();
