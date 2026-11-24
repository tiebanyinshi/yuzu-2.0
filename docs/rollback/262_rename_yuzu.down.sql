-- 回滚 262_rename_yuzu.sql。先停服务、先备份。
-- 把还是「柚子 · 城市汤泉」的默认门店名、本店、本公司名改回「浴族 · 城市汤泉」（店里自己改过的不动）。
BEGIN;
UPDATE settings SET value = '"浴族 · 城市汤泉"'::jsonb, updated_at = now()
WHERE key = 'store_name' AND value = '"柚子 · 城市汤泉"'::jsonb;
UPDATE stores SET name = '浴族 · 城市汤泉' WHERE name = '柚子 · 城市汤泉';
UPDATE legal_entities SET name = '浴族 · 城市汤泉' WHERE name = '柚子 · 城市汤泉';
COMMIT;
