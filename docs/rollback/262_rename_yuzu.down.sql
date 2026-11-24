-- 回滚 262_rename_yuzu.sql。先停服务、先备份。
-- 把还是「柚子 · 城市汤泉」的默认门店名、本店、本公司名改回「浴族 · 城市汤泉」（店里自己改过的不动）。
BEGIN;
UPDATE settings SET value = '"浴族 · 城市汤泉"'::jsonb, updated_at = now()
WHERE key = 'store_name' AND value = '"柚子 · 城市汤泉"'::jsonb;
-- 只改有迁移来源证据的那两行：153 照默认门店名建的本店、本公司（id 都是 1），而且现在还叫新名字、表里没有别的行叫旧名字
-- （按唯一索引的口径 lower(btrim(name))）。升级前就叫新名字的分店、主体（id 不是 1）一律不动（测试会话报告）。
-- 推断不了的（例如 1 号在升级前就是自定义名字、或者升级后又改过）都不动；要精确回到升级前，按 docs/RELEASE_V800.md 用升级前的备份恢复
-- （scripts/rollback.sh 有新增迁移时就是恢复备份），这份手工脚本只处理没撞名的常规情形。
UPDATE stores SET name = '浴族 · 城市汤泉' WHERE id = 1 AND name = '柚子 · 城市汤泉'
  AND NOT EXISTS (SELECT 1 FROM stores o WHERE lower(btrim(o.name)) = lower(btrim('浴族 · 城市汤泉')));
UPDATE legal_entities SET name = '浴族 · 城市汤泉' WHERE id = 1 AND name = '柚子 · 城市汤泉'
  AND NOT EXISTS (SELECT 1 FROM legal_entities o WHERE lower(btrim(o.name)) = lower(btrim('浴族 · 城市汤泉')));
COMMIT;
