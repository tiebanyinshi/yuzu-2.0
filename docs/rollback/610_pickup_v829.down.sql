-- 回滚 620_pickup_v829.sql（8.2.9 水吧取餐号）。先停服务、先备份；只在回到 8.2.9 以前的版本时执行。
-- 会丢掉：取餐号与小票二维码的查进度编号（出品单照旧在，厨房屏照旧能做、能上）。
BEGIN;
DROP TABLE pickup_tickets;
DROP FUNCTION yuzu_pickup_ticket_guard();
DELETE FROM schema_migrations WHERE version = '610_pickup_v829.sql';
COMMIT;
