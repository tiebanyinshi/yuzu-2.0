-- 回滚 321_gift_cards.sql（8.1.40 礼品卡批次）。先停服务、先备份；只在回到 8.1.40 以前的版本时执行。
-- 礼品卡生成的会员照旧是匿名卡会员（会员、储值都不动），只去掉「哪一批生成的」这一列与批次表。
BEGIN;
DROP INDEX members_gift_batch_idx;
ALTER TABLE members DROP COLUMN gift_batch_id;
DROP TABLE gift_card_batches;
DELETE FROM schema_migrations WHERE version = '321_gift_cards.sql';
COMMIT;
