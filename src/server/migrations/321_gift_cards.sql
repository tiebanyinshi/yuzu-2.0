-- 8.1.40（docs/V8140.md 第 5 节）：礼品卡先出卡、后绑手机号（《门店系统需求梳理与优化方案》「礼品卡批量生成」）。
-- 不另建一套卡：礼品卡就是匿名卡会员（不要手机号，会员号就是卡号，迁移前就有），一批一次生成；
-- 送出去以后在会员资料里「转实名」填手机号（转实名、改手机号的规矩照旧）。储值照常按充值走钱包。
--   · gift_card_batches：一批礼品卡（批号、名称、几张、经办人、操作编号）；
--   · members.gift_batch_id：这位匿名卡会员是哪一批礼品卡生成的（别的会员为空）。
-- 回滚：docs/rollback/321_gift_cards.down.sql。

CREATE TABLE gift_card_batches (
  id          bigserial PRIMARY KEY,
  batch_no    text NOT NULL UNIQUE CHECK (char_length(batch_no) BETWEEN 1 AND 32),
  label       text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 16),
  quantity    integer NOT NULL CHECK (quantity BETWEEN 1 AND 200),
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  client_key  uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  store_id    bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER gift_card_batches_append_only BEFORE UPDATE OR DELETE ON gift_card_batches
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

ALTER TABLE members ADD COLUMN gift_batch_id bigint REFERENCES gift_card_batches (id);
CREATE INDEX members_gift_batch_idx ON members (gift_batch_id) WHERE gift_batch_id IS NOT NULL;
