-- 8.2.30 收银合并（店主 2026-11-27 评审 PR #68，设计见 docs/V8230_CASHIER.md）：
--   · 港元现金（CM-2、CM-3）：收款方式照旧记「现金」、金额照旧是人民币分（营业额、实收、日结都按人民币）；
--     收的是港元时另记客人实给的港元（港仙）、当时的汇率（每 1 港元折多少人民币，百万分之一）、折成人民币多少、找给客人的人民币；
--   · 班次的港元：应有港元与实点港元（交班时分币种对实点）；
--   · 收银申请 cashier_requests（CM-5、CM-6）：没有权限的收银员申请退款单或反结账，有权限的人批准时按当时的数据重新核对再执行；
--   · 操作编号与「确认作废」追加 cashier_request（提交申请；在当时的约束上追加）。批准退款单的申请用退款单自己的操作编号。
-- 风险已知：checkout_payments、shifts 只加可空的列（旧数据都是人民币，列为空）；新表只追加。回滚见 docs/rollback/760_cashier_v8230.down.sql。

ALTER TABLE checkout_payments
  ADD COLUMN fx_currency text CHECK (fx_currency IN ('HKD')),
  ADD COLUMN fx_tendered integer CHECK (fx_tendered > 0),
  ADD COLUMN fx_rate_ppm integer CHECK (fx_rate_ppm > 0),
  ADD COLUMN fx_worth integer CHECK (fx_worth > 0),
  ADD COLUMN fx_change integer CHECK (fx_change >= 0);
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_fx_check CHECK (
  (fx_currency IS NULL AND fx_tendered IS NULL AND fx_rate_ppm IS NULL AND fx_worth IS NULL AND fx_change IS NULL) OR
  (fx_currency IS NOT NULL AND method = 'cash' AND fx_tendered IS NOT NULL AND fx_rate_ppm IS NOT NULL AND fx_worth IS NOT NULL
   AND fx_change IS NOT NULL AND fx_worth = amount + fx_change)
) NOT VALID;
ALTER TABLE checkout_payments VALIDATE CONSTRAINT checkout_payments_fx_check;
COMMENT ON COLUMN checkout_payments.fx_currency IS '8.2.30：收的是外币现金时的币种（只有 HKD）；空 = 人民币';
COMMENT ON COLUMN checkout_payments.fx_tendered IS '8.2.30：客人实给的港元（港仙），全部进钱箱';
COMMENT ON COLUMN checkout_payments.fx_rate_ppm IS '8.2.30：收款时的汇率快照：每 1 港元折多少人民币（百万分之一，920000 = 0.92）';
COMMENT ON COLUMN checkout_payments.fx_worth IS '8.2.30：实给的港元折成人民币（分，向下取整）= 这笔收款 amount + 找零 fx_change';
COMMENT ON COLUMN checkout_payments.fx_change IS '8.2.30：从钱箱找给客人的人民币（分）';

ALTER TABLE shifts
  ADD COLUMN expected_hkd integer,
  ADD COLUMN counted_hkd integer CHECK (counted_hkd >= 0);
COMMENT ON COLUMN shifts.expected_hkd IS '8.2.30：交班时应有港元（港仙）；本班次没收过港元为空';
COMMENT ON COLUMN shifts.counted_hkd IS '8.2.30：交班时实点港元（港仙）；本班次没收过港元为空';
-- 交班时一起写的列加上港元两列（其余照 015：只能交班一次，交班后不能改）
CREATE OR REPLACE FUNCTION yuzu_shift_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  close_cols constant text[] := ARRAY['status', 'ended_at', 'expected_cash', 'counted_cash', 'expected_hkd', 'counted_hkd', 'summary', 'note', 'handed_to', 'closed_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '班次记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (OLD.status = 'open' AND NEW.status = 'closed')
     OR (to_jsonb(NEW) - close_cols) <> (to_jsonb(OLD) - close_cols) THEN
    RAISE EXCEPTION '班次只能交班一次，交班后不能修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE cashier_requests (
  id            bigserial PRIMARY KEY,
  store_id      bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  request_no    text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('refund', 'void')),
  checkout_id   bigint NOT NULL REFERENCES checkouts (id),
  -- 退款单：要退的项目、退款方式、钱箱（与开退款单的请求一样，不含操作编号）；反结账：钱箱
  payload       jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  amount        integer NOT NULL CHECK (amount >= 0),
  reason        text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  client_key    uuid NOT NULL UNIQUE,
  requested_by  bigint NOT NULL REFERENCES staff (id),
  requested_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  decided_by    bigint REFERENCES staff (id),
  decided_at    timestamptz,
  decision_note text NOT NULL DEFAULT '' CHECK (char_length(decision_note) <= 200),
  refund_id     bigint REFERENCES refunds (id),
  CHECK (expires_at > requested_at),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status NOT IN ('approved', 'rejected', 'cancelled') OR decided_by IS NOT NULL),
  CHECK (status <> 'rejected' OR char_length(btrim(decision_note)) >= 2),
  CHECK ((refund_id IS NOT NULL) = (kind = 'refund' AND status = 'approved'))
);
COMMENT ON TABLE cashier_requests IS '8.2.30 收银申请：没有权限的收银员申请退款单或反结账，有权限的人批准时按当时的数据重新核对、走原来的退款 / 反结账再执行（金额单位：分）';
COMMENT ON COLUMN cashier_requests.amount IS '申请退的金额（分）；反结账是结账单的金额';
COMMENT ON COLUMN cashier_requests.status IS 'pending 待审批、approved 已批准并执行、rejected 驳回、expired 失效（超时或单子已经变了）、cancelled 申请人撤回';
COMMENT ON COLUMN cashier_requests.decision_note IS '驳回的原因、失效的原因或批准时的说明';
CREATE INDEX cashier_requests_checkout_idx ON cashier_requests (checkout_id);
CREATE INDEX cashier_requests_requested_by_idx ON cashier_requests (requested_by);
CREATE INDEX cashier_requests_decided_by_idx ON cashier_requests (decided_by);
CREATE INDEX cashier_requests_refund_idx ON cashier_requests (refund_id);
CREATE INDEX cashier_requests_pending_idx ON cashier_requests (store_id, requested_at) WHERE status = 'pending';
-- 同一张结账单同时只能有一张待审批的申请
CREATE UNIQUE INDEX cashier_requests_one_pending ON cashier_requests (checkout_id) WHERE status = 'pending';

-- 只追加：只能从待审批变成一种结果一次，别的列不改，不删
CREATE FUNCTION yuzu_cashier_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '收银申请只追加，不能删除'; END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending'
     OR (NEW.id, NEW.store_id, NEW.request_no, NEW.kind, NEW.checkout_id, NEW.payload, NEW.amount, NEW.reason, NEW.client_key,
         NEW.requested_by, NEW.requested_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.request_no, OLD.kind, OLD.checkout_id, OLD.payload, OLD.amount, OLD.reason, OLD.client_key,
                          OLD.requested_by, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION '收银申请只能处理一次，申请的内容不能改';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cashier_requests_guard BEFORE UPDATE OR DELETE ON cashier_requests FOR EACH ROW EXECUTE FUNCTION yuzu_cashier_request_guard();

DO $$
DECLARE
  t text;
  expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression
    FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type = ANY (ARRAY[''cashier_request''::text]))',
                   t, t || '_op_type_check', expression);
  END LOOP;
END $$;
