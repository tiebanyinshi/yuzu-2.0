-- Design 素材库的用途按门店分开设（8.1.33，Codex 安全审查；docs/BOARDS.md 第 4 节）：
-- 只挂在分店的设计师不能改总店的门户横幅、大屏待机视频、平板英文字体。素材与版本照旧全公司一份，只有「用途现在用哪一版」分门店。
-- 已有的切换记录与确认作废都是本店（编号 1）的；新写的行默认取当前门店（yuzu_store()，与别的业务表一样）。
-- 风险已知：只加列（已有行填 1）、换索引，不删数据、不改已有记录的内容；回滚见 docs/rollback/266_design_slot_store.down.sql。

ALTER TABLE design_slot_assignments ADD COLUMN store_id bigint NOT NULL DEFAULT 1 REFERENCES stores (id);
ALTER TABLE design_slot_assignments ALTER COLUMN store_id SET DEFAULT yuzu_store();
DROP INDEX design_slot_assignments_slot_idx;
CREATE INDEX design_slot_assignments_store_slot_idx ON design_slot_assignments (store_id, slot, id DESC);

ALTER TABLE design_assign_fences ADD COLUMN store_id bigint NOT NULL DEFAULT 1 REFERENCES stores (id);
ALTER TABLE design_assign_fences ALTER COLUMN store_id SET DEFAULT yuzu_store();
