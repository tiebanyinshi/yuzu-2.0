-- 回滚 202_room_orders.sql（8.2.0 P07 房态点单）。先停服务、先备份；只在回到 8.2.0 以前的版本时执行。
-- 删掉房态点单的三张表。点过的单照旧在账单明细与出品单上（挂账、退菜、结账不受影响），只是房间卡片上不再显示单数与金额、看不到「这间房点过什么」。
-- 回滚后旧版本不认识这三张表，不读也不写；schema_migrations 里删掉 202 这一行，以后重新升级会再建（以前的房态点单记录不会回来）。
BEGIN;
DROP TABLE IF EXISTS room_order_lines;
DROP TABLE IF EXISTS room_orders;
DROP TABLE IF EXISTS room_order_outlets;
DELETE FROM schema_migrations WHERE version = '202_room_orders.sql';
COMMIT;
