-- 回滚 740_tag_exceptions_v8221.sql：去掉锁定原因类别与来访（挂失、未交回的牌照旧锁着，只是不再分类）。
DROP INDEX IF EXISTS hand_tags_lock_visit_id_idx;
ALTER TABLE hand_tags DROP CONSTRAINT IF EXISTS hand_tags_lock_visit_id_fkey;
ALTER TABLE hand_tags DROP CONSTRAINT IF EXISTS hand_tags_lock_kind_ck;
ALTER TABLE hand_tags DROP COLUMN IF EXISTS lock_visit_id, DROP COLUMN IF EXISTS lock_kind;
DELETE FROM schema_migrations WHERE version = '740_tag_exceptions_v8221.sql';
