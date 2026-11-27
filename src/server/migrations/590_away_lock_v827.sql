-- 8.2.7 收银台「锁牌外出」（店主 2026-11-27：收银台要能锁牌，锁牌时间不超过四个小时；客人外出锁牌要先收预售的钱；设计见 docs/V8227_AWAY_LOCK.md）：
--   · visit_tag_locks：在店客人外出时把他的手牌锁住——锁着期间这张牌上不能再挂账，客人回来解锁、结账时自动解锁，
--     到时间（最多 4 小时）自动解锁并提醒值班经理；
--   · 锁之前先收「预售」：同一笔里收一张手牌押金（原因「锁牌外出预收」），结账时照押金的规矩抵扣（tag_deposit_id 必填）；
--   · 操作编号与「确认作废」追加 tag_away_lock、tag_away_unlock（在当时的约束上追加）。
-- 原来的「锁牌」（hand_tags.locked：把空闲的牌停用）不变。
-- 风险已知：只加表、在当时的约束上追加两个类型。回滚见 docs/rollback/590_away_lock_v827.down.sql。

CREATE TABLE visit_tag_locks (
  id             bigserial PRIMARY KEY,
  store_id       bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  visit_id       bigint NOT NULL REFERENCES visits (id),
  tag_id         bigint NOT NULL REFERENCES hand_tags (id),
  locked_at      timestamptz NOT NULL,
  lock_until     timestamptz NOT NULL,
  reason         text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 64),
  tag_deposit_id bigint NOT NULL UNIQUE REFERENCES tag_deposits (id),
  client_key     uuid NOT NULL UNIQUE,
  locked_by      bigint NOT NULL REFERENCES staff (id),
  released_at    timestamptz,
  released_by    bigint REFERENCES staff (id),
  release_kind   text CHECK (release_kind IN ('return', 'expired', 'checkout')),
  CHECK (lock_until > locked_at AND lock_until <= locked_at + interval '4 hours'),
  CHECK ((released_at IS NULL) = (release_kind IS NULL)),
  CHECK (release_kind IS NULL OR release_kind = 'expired' OR released_by IS NOT NULL)
);
COMMENT ON TABLE visit_tag_locks IS '8.2.7 锁牌外出：在店客人外出时锁住他的手牌（最多 4 小时），锁之前先收预售（一张手牌押金，结账时抵扣）；锁着期间不能挂账';
COMMENT ON COLUMN visit_tag_locks.lock_until IS '到这个时刻自动解锁（不超过锁牌时刻 + 4 小时）';
COMMENT ON COLUMN visit_tag_locks.tag_deposit_id IS '锁牌前收的预售（手牌押金，原因「锁牌外出预收」），结账时照押金抵扣';
COMMENT ON COLUMN visit_tag_locks.release_kind IS 'return 客人回来解锁、expired 到时间自动解锁、checkout 结账时解锁；空 = 还锁着';
CREATE INDEX visit_tag_locks_visit_idx ON visit_tag_locks (visit_id);
CREATE INDEX visit_tag_locks_tag_idx ON visit_tag_locks (tag_id);
CREATE INDEX visit_tag_locks_locked_by_idx ON visit_tag_locks (locked_by);
CREATE INDEX visit_tag_locks_released_by_idx ON visit_tag_locks (released_by);
-- 一次来访同时只有一把锁；到期扫描按 lock_until 找
CREATE UNIQUE INDEX visit_tag_locks_active_uq ON visit_tag_locks (visit_id) WHERE released_at IS NULL;
CREATE INDEX visit_tag_locks_due_idx ON visit_tag_locks (lock_until) WHERE released_at IS NULL;

-- 只追加：解锁只能填一次（释放的三列从空到有），别的列不改，不删
CREATE FUNCTION yuzu_visit_tag_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '锁牌记录只追加，不能删除'; END IF;
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
     OR (NEW.id, NEW.store_id, NEW.visit_id, NEW.tag_id, NEW.locked_at, NEW.lock_until, NEW.reason, NEW.tag_deposit_id, NEW.client_key, NEW.locked_by)
        IS DISTINCT FROM (OLD.id, OLD.store_id, OLD.visit_id, OLD.tag_id, OLD.locked_at, OLD.lock_until, OLD.reason, OLD.tag_deposit_id, OLD.client_key, OLD.locked_by) THEN
    RAISE EXCEPTION '锁牌记录只能解锁一次，别的不能改';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER visit_tag_locks_guard BEFORE UPDATE OR DELETE ON visit_tag_locks FOR EACH ROW EXECUTE FUNCTION yuzu_visit_tag_lock_guard();

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
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type = ANY (ARRAY[''tag_away_lock''::text, ''tag_away_unlock''::text]))',
                   t, t || '_op_type_check', expression);
  END LOOP;
END $$;
