-- 回滚 262_rename_yuzu.sql。先停服务、先备份。
-- 把还是「柚子 · 城市汤泉」的默认门店名、本店、本公司名改回「浴族 · 城市汤泉」（店里自己改过的不动）。
BEGIN;
UPDATE settings SET value = '"浴族 · 城市汤泉"'::jsonb, updated_at = now()
WHERE key = 'store_name' AND value = '"柚子 · 城市汤泉"'::jsonb;
-- 升级时撞名没改的（默认那一行还叫「浴族 · 城市汤泉」）：「柚子 · 城市汤泉」是店里自己那家，不动。
-- 判断按唯一索引的口径 lower(btrim(name))。回滚只能凭现在的名字推断，推断不了（例如升级后店里又把别的改成了旧名）的一律不动；
-- 要精确回到升级前，用升级前的备份恢复（docs/RELEASE_V800.md 的回滚流程），这份脚本只处理没撞名的常规情形。
UPDATE stores SET name = '浴族 · 城市汤泉' WHERE name = '柚子 · 城市汤泉'
  AND NOT EXISTS (SELECT 1 FROM stores o WHERE lower(btrim(o.name)) = lower(btrim('浴族 · 城市汤泉')))
  AND (SELECT count(*) FROM stores o WHERE lower(btrim(o.name)) = lower(btrim('柚子 · 城市汤泉'))) = 1;
UPDATE legal_entities SET name = '浴族 · 城市汤泉' WHERE name = '柚子 · 城市汤泉'
  AND NOT EXISTS (SELECT 1 FROM legal_entities o WHERE lower(btrim(o.name)) = lower(btrim('浴族 · 城市汤泉')))
  AND (SELECT count(*) FROM legal_entities o WHERE lower(btrim(o.name)) = lower(btrim('柚子 · 城市汤泉'))) = 1;
COMMIT;
