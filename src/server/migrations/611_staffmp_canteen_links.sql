-- 员工小程序线 E（店主 2026-11-27，docs/STAFF_MP.md 第 5.4 节，SP10）：员工账号与柚子饭堂账号对上。
-- 柚子饭堂、巡场用的是饭堂自己的员工名单（canteen_employees，与系统账号分开）；员工小程序用系统账号登录，
-- 吃饭、巡场时按这张表找到这位员工的饭堂身份，照用饭堂与巡场原来的规则（一人一餐一次、饭卡码 30 秒一换、巡场一轮一次）。
--   · 一人一个、一张饭卡也只对给一个人（主键与唯一约束兜底）；
--   · 怎么对上的：后台按手机号预先对好（admin）、员工用旧饭堂账号密码证明（password）、员工在小程序里开通的新饭卡（created）；
--   · 解开就删这一行（谁、什么时候在审计里）；饭堂名单、打卡记录都不动。
-- 只建员工小程序线自己的表，不改已有的表。回滚：docs/rollback/611_staffmp_canteen_links.down.sql。

CREATE TABLE staffmp_canteen_links (
  staff_id     bigint PRIMARY KEY REFERENCES staff (id),
  employee_id  bigint NOT NULL UNIQUE REFERENCES canteen_employees (id),
  method       text NOT NULL CHECK (method IN ('admin', 'password', 'created')),
  linked_at    timestamptz NOT NULL DEFAULT now(),
  -- 后台对上的是那位管理员；员工自己对上、开通的是本人
  linked_by    bigint NOT NULL REFERENCES staff (id)
);
COMMENT ON TABLE staffmp_canteen_links IS '员工小程序（docs/STAFF_MP.md 第 5.4 节）：员工账号与柚子饭堂账号（canteen_employees）一对一对上；解开就删';
