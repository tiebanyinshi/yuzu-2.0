-- 改名（店主 2026-11-24）：系统中文名「浴族」改叫「柚子」。
-- 001 写进去的默认门店名「浴族 · 城市汤泉」还没被改过的（演示库、刚装好的库），连同 153 照它建的本店、本公司名一起改成「柚子 · 城市汤泉」；
-- 店里自己设过名字的一概不动（只改与旧默认值完全相同的那一行）。
-- 风险已知：只改与旧默认值一字不差的三行名称，不删数据、不改账本；回滚见 docs/rollback/262_rename_yuzu.down.sql。

UPDATE settings SET value = '"柚子 · 城市汤泉"'::jsonb, updated_at = now()
WHERE key = 'store_name' AND value = '"浴族 · 城市汤泉"'::jsonb;

-- 新名字已经被别的分店、别的公司主体用了（名称唯一）：这一行不改，留旧名，ID 与关联不动、已有那家的名字也不动，店里在后台自己改。
-- 8.1.32 补（店主 2026-11-24 同意破例改已发布的迁移）：原来的写法遇到这种库整份迁移失败、升级停在 262；
-- 只在当时失败过、还没登记 262 的库上行为不同，已经跑成功的库不受影响（迁移按文件名登记，不核对内容）。
UPDATE stores SET name = '柚子 · 城市汤泉' WHERE name = '浴族 · 城市汤泉'
  AND NOT EXISTS (SELECT 1 FROM stores o WHERE o.name = '柚子 · 城市汤泉');

UPDATE legal_entities SET name = '柚子 · 城市汤泉' WHERE name = '浴族 · 城市汤泉'
  AND NOT EXISTS (SELECT 1 FROM legal_entities o WHERE o.name = '柚子 · 城市汤泉');
