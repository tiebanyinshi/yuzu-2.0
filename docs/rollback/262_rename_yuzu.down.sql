-- 回滚 262_rename_yuzu.sql：这份脚本不写任何东西，只列出现在的名字供核对。
-- 262 只改与旧默认值「浴族 · 城市汤泉」一字不差的门店名设置、本店、本公司（撞名的跳过），但迁移没有记下改之前的值：
-- 升级前就合法叫「柚子 · 城市汤泉」的（不论是不是 1 号）与 262 改过来的分不出来，凭现在的名字改回去会误改店里自己的名字
-- （测试会话报告两轮：升级前就叫新名字的分店、主体，以及 1 号本店、本公司、store_name 本来就叫新名字）。
-- 要回到升级前：按 docs/RELEASE_V800.md 的回滚流程用升级前的备份恢复（scripts/rollback.sh 遇到有新增迁移时就是恢复备份）。
-- 只是名字不想要了：在后台「门店与主体」、门店名设置里手工改回，不用回滚。
SELECT 'settings.store_name' AS 位置, value #>> '{}' AS 现在的名字 FROM settings WHERE key = 'store_name'
UNION ALL
SELECT 'stores#' || id, name FROM stores WHERE lower(btrim(name)) IN (lower('柚子 · 城市汤泉'), lower('浴族 · 城市汤泉'))
UNION ALL
SELECT 'legal_entities#' || id, name FROM legal_entities WHERE lower(btrim(name)) IN (lower('柚子 · 城市汤泉'), lower('浴族 · 城市汤泉'));
