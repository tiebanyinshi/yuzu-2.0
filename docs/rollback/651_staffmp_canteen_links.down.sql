-- 回滚 651_staffmp_canteen_links.sql（员工小程序线 E，docs/STAFF_MP.md 第 5.4 节）：删员工账号与饭堂账号的对上表。先停服务、先备份。
-- 会丢掉：谁的系统账号对上了哪张饭卡。饭堂名单、打卡记录、员工小程序开通的饭卡（canteen_employees 里的行）都不动。
BEGIN;
DROP TABLE staffmp_canteen_links;
DELETE FROM schema_migrations WHERE version = '651_staffmp_canteen_links.sql';
COMMIT;
