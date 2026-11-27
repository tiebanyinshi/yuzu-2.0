-- 8.2.20 休闲娱乐（docs/V82220_LEISURE.md）：网吧、桌球按「基础价含时长 + 加钟价」计时收费（价目表「39/2h、加钟/19.9」）。
--   开单即占用的计费多一种：房费项目的价格是基础价（含起步时长），起步以后每个计费单位按加钟价另记一条明细；
--   使用单计费表 space_usage_charges 的类型加 extra（加钟那一条；一张使用单一条，主键仍是 usage_id + kind）。
-- 只放宽约束，不改已有的行。

ALTER TABLE space_usage_charges DROP CONSTRAINT space_usage_charges_kind_check;
ALTER TABLE space_usage_charges ADD CONSTRAINT space_usage_charges_kind_check CHECK (kind IN ('fee', 'open_fee', 'extra'));

COMMENT ON COLUMN space_usage_charges.kind IS '房费 fee / 开台费 open_fee / 加钟 extra（8.2.20：基础价含起步时长、起步以后按加钟价另记）';
