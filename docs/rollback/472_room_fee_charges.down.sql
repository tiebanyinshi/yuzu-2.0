-- 回滚 472_room_fee_charges.sql（福田店整改后续：房费在收银台收）。先停服务、先备份；只在回到这一版以前的版本时执行。
-- 房费明细留在账单上（是正常的挂账），只删掉对应关系表。
BEGIN;
DROP TABLE room_fee_charges;
DROP FUNCTION yuzu_room_fee_charges_append_only();
DELETE FROM schema_migrations WHERE version = '472_room_fee_charges.sql';
COMMIT;
