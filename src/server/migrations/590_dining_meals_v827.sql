-- 8.2.7 餐厅（店主 2026-11-27《新店系统需求现场走场确认》第一节第 1 条、第四节待办；设计见 docs/V8227_DINING_MEALS.md）：
--   · 票种含几餐：ticket_types.meals_12h / meals_24h（默认 0；名字是「含餐门票」的按原来写在备注里的 2 / 3 餐填上）；
--   · 餐厅入口刷手牌登记进餐：meal_entries（一位客人同一营业日同一餐段只登记一次，只追加）；
--   · 自动折扣：bill_line_discounts 的档加 auto（系统按规则打的，没有授权人）、加 rule（included_meal 含餐 / buffet 自助 / first_cup 首杯赠，8.2.8 用）；
--   · 餐包 = 开台的桌台（桌台点单照价收，不做含餐、自助的减免），不用加列；
--   · 操作编号与「确认作废」追加 meal_entry。
-- 风险已知：只加列、加表、在当时的约束上追加；ticket_types 按名字回填含几餐。回滚见 docs/rollback/590_dining_meals_v827.down.sql。

ALTER TABLE ticket_types ADD COLUMN meals_12h smallint NOT NULL DEFAULT 0 CHECK (meals_12h BETWEEN 0 AND 9);
ALTER TABLE ticket_types ADD COLUMN meals_24h smallint NOT NULL DEFAULT 0 CHECK (meals_24h BETWEEN 0 AND 9);
COMMENT ON COLUMN ticket_types.meals_12h IS '8.2.7：12 小时档含几餐（餐厅入口登记时抵扣，0 = 不含餐）';
COMMENT ON COLUMN ticket_types.meals_24h IS '8.2.7：24 小时档（在店满 12 小时以后）含几餐';
UPDATE ticket_types SET meals_12h = 2, meals_24h = 3 WHERE name = '含餐门票';

ALTER TABLE bill_line_discounts ADD COLUMN rule text CHECK (rule IN ('included_meal', 'buffet', 'first_cup'));
COMMENT ON COLUMN bill_line_discounts.rule IS '8.2.7：系统按规则打的自动折扣（档 auto）是哪条规则：included_meal 含餐、buffet 自助、first_cup 首杯赠；人工打的为空';
DO $$
DECLARE
  expression text;
  t text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'bill_line_discounts'::regclass AND conname = 'bill_line_discounts_tier_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原打折档约束不存在'; END IF;
  ALTER TABLE bill_line_discounts DROP CONSTRAINT bill_line_discounts_tier_check;
  EXECUTE format('ALTER TABLE bill_line_discounts ADD CONSTRAINT bill_line_discounts_tier_check CHECK ((%s) OR tier = ''auto'')', expression);

  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression
    FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type = ''meal_entry'')', t, t || '_op_type_check', expression);
  END LOOP;
END $$;
-- 自动折扣：规则必填、没有授权人；人工打的没有规则
ALTER TABLE bill_line_discounts ADD CONSTRAINT bill_line_discounts_auto_check CHECK ((tier = 'auto') = (rule IS NOT NULL) AND (tier <> 'auto' OR approved_by IS NULL)) NOT VALID;
ALTER TABLE bill_line_discounts VALIDATE CONSTRAINT bill_line_discounts_auto_check;

CREATE TABLE meal_entries (
  id            bigserial PRIMARY KEY,
  store_id      bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  visit_id      bigint NOT NULL REFERENCES visits (id),
  business_date date NOT NULL,
  period        text NOT NULL CHECK (period IN ('breakfast', 'lunch', 'dinner', 'supper')),
  kind          text NOT NULL CHECK (kind IN ('included', 'paid')),
  price         bigint NOT NULL CHECK (price > 0),
  line_id       bigint NOT NULL UNIQUE REFERENCES bill_lines (id),
  client_key    uuid NOT NULL UNIQUE,
  staff_id      bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL
);
COMMENT ON TABLE meal_entries IS '8.2.7 餐厅入口刷手牌登记进餐：同一来访同一营业日同一餐段一条（那一行餐费作废了的可以重新登记）；含餐的那一行餐费自动折成 0，裸票照价收；只追加。金额单位分';
COMMENT ON COLUMN meal_entries.period IS '餐段：breakfast 早餐 / lunch 午餐 / dinner 晚餐 / supper 夜宵（时间与价钱在餐饮规则里）';
COMMENT ON COLUMN meal_entries.kind IS 'included 含餐抵扣（餐费折成 0）/ paid 裸票照价收';
COMMENT ON COLUMN meal_entries.price IS '这一餐段的餐费（分，记在那一行明细上的原价）';
COMMENT ON COLUMN meal_entries.line_id IS '记在手牌上的那一行餐费明细';
-- 同一餐段只登记一次在锁住来访以后核对（那一行餐费作废了的可以重新登记），这里只建查询用的索引
CREATE INDEX meal_entries_visit_idx ON meal_entries (visit_id, business_date, period);
CREATE INDEX meal_entries_day_idx ON meal_entries (store_id, business_date);
CREATE INDEX meal_entries_staff_idx ON meal_entries (staff_id);
CREATE FUNCTION yuzu_meal_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '进餐登记只追加，不能改、不能删（登记错了作废那一行餐费）';
END $$;
CREATE TRIGGER meal_entries_guard BEFORE UPDATE OR DELETE ON meal_entries FOR EACH ROW EXECUTE FUNCTION yuzu_meal_entry_guard();
