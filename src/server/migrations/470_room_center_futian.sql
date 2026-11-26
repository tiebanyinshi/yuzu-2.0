-- 福田店整改批次 2（2026-11-26《福田店餐饮与房态中心整改需求文档》，docs/FUTIAN_1126.md）：
--   · 登记单分三种：普通、括单（技师自己约的客人，FT-07）、补单（事后补录的漏单 / 手工单，FT-19）；
--   · 登记单多两种结束方式：撤房（开房后限时内撤掉、不收费，FT-09）、补单（补录时一建就结束）；
--   · 房间事件多几种：撤房、补单、房费（按时间计费，FT-10 / FT-17）；
--   · 钟单记「不算用过房间」（room_neutral）：撤房作废的、补单补录的钟不让房间转待清。
-- 风险已知：只加列（已有行取默认值）、把两个类型约束放宽成原来的超集，不删数据、不改已有记录与账本；回滚见 docs/rollback/470_room_center_futian.down.sql。

ALTER TABLE room_registrations ADD COLUMN kind text NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'bracket', 'backfill'));

ALTER TABLE room_registrations DROP CONSTRAINT room_registrations_close_kind_check;
ALTER TABLE room_registrations ADD CONSTRAINT room_registrations_close_kind_check
  CHECK (close_kind IN ('checkout', 'settled', 'visit_cancel', 'revoked', 'backfill'));

ALTER TABLE space_room_events DROP CONSTRAINT space_room_events_kind_check;
ALTER TABLE space_room_events ADD CONSTRAINT space_room_events_kind_check
  CHECK (kind IN ('register', 'move_out', 'move_in', 'checkout', 'extend', 'merge', 'unmerge', 'dirty', 'cleaned', 'maintenance', 'restore',
                  'revoke', 'backfill', 'room_fee'));

ALTER TABLE technician_sessions ADD COLUMN room_neutral boolean NOT NULL DEFAULT false;
