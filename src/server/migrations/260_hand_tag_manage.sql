-- 手牌管理（店主 2026-11-24，docs/FRONTDESK_TAGS_V8127.md）：
--   · 手牌柜的使用状态：正常 / 暂停使用 / 维修中（service_status），带说明、经办人与时间；不是「正常」的前台发不出；
--   · 删除手牌：从来没发过的直接删掉；发过的（来访、换牌记录引用着它）改成「已删除」（deleted_at），
--     同时停用，手牌池与前台都不再列出，历史单据照旧显示牌号。
-- 只加列，已有的手牌都是「正常」、没删除。

ALTER TABLE hand_tags
  ADD COLUMN service_status text NOT NULL DEFAULT 'normal' CHECK (service_status IN ('normal', 'paused', 'repair')),
  ADD COLUMN service_note   text CHECK (char_length(service_note) BETWEEN 1 AND 100),
  ADD COLUMN service_by     bigint REFERENCES staff (id),
  ADD COLUMN service_at     timestamptz,
  ADD COLUMN deleted_at     timestamptz,
  ADD COLUMN deleted_by     bigint REFERENCES staff (id),
  -- 删除了的一定是停用的（前台、换牌只认 active）
  ADD CONSTRAINT hand_tags_deleted_inactive CHECK (deleted_at IS NULL OR NOT active);
