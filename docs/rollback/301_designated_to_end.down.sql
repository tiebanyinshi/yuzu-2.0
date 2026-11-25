-- 回滚 301_designated_to_end.sql（8.1.38 点钟下钟后排到队尾）。先停服务、先备份；只在回到 8.1.38 以前的版本时执行。
-- 旧版本不认识 finish：存成 finish 的改回原来的默认「不动牌」（keep）。
BEGIN;
UPDATE settings SET value = jsonb_set(value, '{afterDesignated}', '"keep"') WHERE key = 'clockroom_rules' AND value->>'afterDesignated' = 'finish';
UPDATE store_settings SET value = jsonb_set(value, '{afterDesignated}', '"keep"') WHERE key = 'clockroom_rules' AND value->>'afterDesignated' = 'finish';
DELETE FROM schema_migrations WHERE version = '301_designated_to_end.sql';
COMMIT;
