-- 8.2.21 未交回、挂失手牌清单（docs/V82221_TAG_EXCEPTIONS.md；店主 2026-11-27 收银员工作台 demo，第 3 项定「做」）。
--   锁定的手牌多记两样：为什么锁（挂失 / 未交回；手动锁的照旧不填）、是哪位客人那次来访丢的或没交回的。
--   清单按这两列列出来，找回了照旧「解锁」，两列一起清掉。
-- 只加两列、一个约束、一个外键，不改已有的行（以前锁的都算手动锁）。

ALTER TABLE hand_tags ADD COLUMN lock_kind text, ADD COLUMN lock_visit_id bigint;

ALTER TABLE hand_tags ADD CONSTRAINT hand_tags_lock_kind_ck
  CHECK (lock_kind IS NULL OR (locked AND lock_kind IN ('lost', 'unreturned'))) NOT VALID;
ALTER TABLE hand_tags VALIDATE CONSTRAINT hand_tags_lock_kind_ck;

ALTER TABLE hand_tags ADD CONSTRAINT hand_tags_lock_visit_id_fkey FOREIGN KEY (lock_visit_id) REFERENCES visits (id) NOT VALID;
ALTER TABLE hand_tags VALIDATE CONSTRAINT hand_tags_lock_visit_id_fkey;
CREATE INDEX hand_tags_lock_visit_id_idx ON hand_tags (lock_visit_id);

COMMENT ON COLUMN hand_tags.lock_kind IS '8.2.21 锁定的原因类别：lost 挂失（客人弄丢）、unreturned 未交回（结了账没还牌）；手动锁的为空。解锁时清掉';
COMMENT ON COLUMN hand_tags.lock_visit_id IS '8.2.21 挂失 / 未交回的是哪一次来访（找当时的客人）；解锁时清掉';
