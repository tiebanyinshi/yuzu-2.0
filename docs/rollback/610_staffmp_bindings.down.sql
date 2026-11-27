-- 回滚 610_staffmp_bindings.sql（员工小程序线，docs/STAFF_MP.md）：删员工小程序的绑定与会话标记两张表。先停服务、先备份。
-- 会丢掉：谁绑了哪个微信、绑定与解绑的记录。员工账号、网页的会话都不动；员工小程序发过的会话先一起删掉（回到旧版本以后没有员工小程序端口）。
BEGIN;
DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM staffmp_sessions);
DROP TABLE staffmp_sessions;
DROP TABLE staffmp_bindings;
DELETE FROM schema_migrations WHERE version = '610_staffmp_bindings.sql';
COMMIT;
