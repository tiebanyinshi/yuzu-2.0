-- 改名（店主 2026-11-24）：系统中文名「浴族」改叫「柚子」。
-- 001 写进去的默认门店名「浴族 · 城市汤泉」还没被改过的（演示库、刚装好的库），连同 153 照它建的本店、本公司名一起改成「柚子 · 城市汤泉」；
-- 店里自己设过名字的一概不动（只改与旧默认值完全相同的那一行）。
-- 风险已知：只改与旧默认值一字不差的三行名称，不删数据、不改账本；回滚见 docs/rollback/262_rename_yuzu.down.sql。

UPDATE settings SET value = '"柚子 · 城市汤泉"'::jsonb, updated_at = now()
WHERE key = 'store_name' AND value = '"浴族 · 城市汤泉"'::jsonb;

UPDATE stores SET name = '柚子 · 城市汤泉' WHERE name = '浴族 · 城市汤泉';

UPDATE legal_entities SET name = '柚子 · 城市汤泉' WHERE name = '浴族 · 城市汤泉';
