-- 8.1.38（docs/V8138.md 第 1 节）：退储值只在充值的那家店办（店主 2026-11-25：「先不允许 a 店钱 b 店退这个操作」）。
-- 充值单（recharges）早就记着门店（迁移 154）；期初余额（老卡迁移）与合并转入还没记，这里补上：
-- 现有行取默认门店（yuzu_store()，没设就是本店）——到今天为止的期初导入、合并都是在本店办的。
-- 回滚：docs/rollback/300_refund_store.down.sql。

ALTER TABLE opening_imports ADD COLUMN store_id bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id);
ALTER TABLE member_merges ADD COLUMN store_id bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id);
