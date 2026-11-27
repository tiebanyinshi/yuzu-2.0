-- 8.2.2 技师（店主 2026-11-26《技师排班系统需求沟通会》，设计见 docs/V8222_TECHNICIANS.md）：
--   扩钟单独一类、加钟在明细上单独标出、上钟后换项目 / 换工种留记录、长假到期自动上牌、技师的手机身高体重星级、
--   提成按门店与星级、每月业绩任务、预约记手牌号。
-- 风险已知：只加列、加两张表、放宽两个上钟方式的约束与钟房日志的类型约束，不改已有数据；回滚见 docs/rollback/540_technicians_v8222.down.sql。

-- ── 扩钟（call 钟，场外预约的客人到店后上的钟）：明细与钟单的上钟方式多一种 call ──
ALTER TABLE bill_lines DROP CONSTRAINT bill_lines_call_type_check;
ALTER TABLE bill_lines ADD CONSTRAINT bill_lines_call_type_check CHECK (call_type IN ('designated', 'rotation', 'call')) NOT VALID;
ALTER TABLE bill_lines VALIDATE CONSTRAINT bill_lines_call_type_check;
ALTER TABLE technician_sessions DROP CONSTRAINT technician_sessions_call_type_check;
ALTER TABLE technician_sessions ADD CONSTRAINT technician_sessions_call_type_check CHECK (call_type IN ('designated', 'rotation', 'call')) NOT VALID;
ALTER TABLE technician_sessions VALIDATE CONSTRAINT technician_sessions_call_type_check;

-- 加钟（同一张钟单上后加的钟）在明细上标出来：报表、提成把加钟与点钟、轮钟、扩钟分开算。挂账时写定，之后不改
ALTER TABLE bill_lines ADD COLUMN clock_extension boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN bill_lines.clock_extension IS '加钟（8.2.2）：这条技师明细是在上钟中的钟单上后加的钟；报表与提成里单列「加钟」';
-- 挂账那一刻技师的星级（8.2.2）：提成按星级取规则时按这一刻的，之后改星级不影响已挂的钟
ALTER TABLE bill_lines ADD COLUMN tech_star smallint CHECK (tech_star BETWEEN 1 AND 10);
COMMENT ON COLUMN bill_lines.tech_star IS '挂账时技师的星级（1–10，8.2.2）；没设星级为空。提成按星级取规则时用它';

-- 钟房日志多一类：换项目 / 换工种（追加在当时的约束上，不照固定名单重建）
DO $$
DECLARE
  expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint
   WHERE conrelid = 'technician_events'::regclass AND conname = 'technician_events_kind_check';
  IF expression IS NULL THEN
    RAISE EXCEPTION '找不到 technician_events_kind_check 约束';
  END IF;
  ALTER TABLE technician_events DROP CONSTRAINT technician_events_kind_check;
  EXECUTE format('ALTER TABLE technician_events ADD CONSTRAINT technician_events_kind_check CHECK ((%s) OR kind = ''change'')', expression);
END $$;

-- ── 换项目 / 换工种的记录（只追加）：上钟不满规定分钟数换项目做标记；换到原技师做不了的项目（换工种）换人，原技师回到原排位 ──
CREATE TABLE technician_session_changes (
  id              bigserial PRIMARY KEY,
  store_id        bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  session_id      bigint NOT NULL REFERENCES technician_sessions (id),
  new_session_id  bigint REFERENCES technician_sessions (id),
  kind            text NOT NULL CHECK (kind IN ('item', 'technician')),
  from_item_id    bigint NOT NULL REFERENCES service_items (id),
  to_item_id      bigint NOT NULL REFERENCES service_items (id),
  reason          text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 100),
  created_by      bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technician_session_changes_kind_check2 CHECK ((kind = 'technician') = (new_session_id IS NOT NULL))
);
CREATE INDEX technician_session_changes_session_id_fk_idx ON technician_session_changes (session_id);
CREATE INDEX technician_session_changes_new_session_id_fk_idx ON technician_session_changes (new_session_id) WHERE new_session_id IS NOT NULL;
CREATE INDEX technician_session_changes_from_item_id_fk_idx ON technician_session_changes (from_item_id);
CREATE INDEX technician_session_changes_to_item_id_fk_idx ON technician_session_changes (to_item_id);
CREATE INDEX technician_session_changes_store_idx ON technician_session_changes (store_id, id);
CREATE TRIGGER technician_session_changes_append_only BEFORE UPDATE OR DELETE ON technician_session_changes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
COMMENT ON TABLE technician_session_changes IS '换项目 / 换工种（8.2.2，只追加）：item 同一位技师换项目（钟单改项目、明细作废重挂），technician 换到原技师做不了的项目、换人做（原钟单收尾、原技师回原排位）';
COMMENT ON COLUMN technician_session_changes.store_id IS '门店';
COMMENT ON COLUMN technician_session_changes.session_id IS '换之前的钟单';
COMMENT ON COLUMN technician_session_changes.new_session_id IS '换工种时新建的钟单（换给的技师）；同一位技师换项目为空';
COMMENT ON COLUMN technician_session_changes.kind IS 'item 换项目（同一位技师）/ technician 换工种（换人）';
COMMENT ON COLUMN technician_session_changes.from_item_id IS '原来的项目';
COMMENT ON COLUMN technician_session_changes.to_item_id IS '换成的项目';
COMMENT ON COLUMN technician_session_changes.reason IS '原因（2–100 字）';
COMMENT ON COLUMN technician_session_changes.created_by IS '经办人';
COMMENT ON COLUMN technician_session_changes.created_at IS '换的时刻';

-- ── 长假到期自动上牌：休假单记「到期自动上牌」，每分钟的任务在休完后的第一个营业日给他上牌（排到队尾）并记下时刻 ──
ALTER TABLE technician_leaves ADD COLUMN auto_return boolean NOT NULL DEFAULT true;
ALTER TABLE technician_leaves ADD COLUMN returned_at timestamptz;
COMMENT ON COLUMN technician_leaves.auto_return IS '休完自动上牌（8.2.2，默认是）：休完后的第一个营业日自动上牌、排到队尾';
COMMENT ON COLUMN technician_leaves.returned_at IS '自动上牌处理过的时刻（上了牌，或那天已经有人手动改过状态、按手动的算）；没处理为空';
CREATE INDEX technician_leaves_return_idx ON technician_leaves (store_id, to_date) WHERE status = 'approved' AND auto_return AND returned_at IS NULL;

-- ── 技师档案：手机、身高、体重、星级（旧系统按星级定提成，原来导入时并成 3 个价格档） ──
ALTER TABLE technicians ADD COLUMN phone text NOT NULL DEFAULT '' CHECK (phone = '' OR phone ~ '^1\d{10}$');
ALTER TABLE technicians ADD COLUMN height_cm smallint CHECK (height_cm BETWEEN 100 AND 230);
ALTER TABLE technicians ADD COLUMN weight_kg smallint CHECK (weight_kg BETWEEN 30 AND 200);
ALTER TABLE technicians ADD COLUMN star smallint CHECK (star BETWEEN 1 AND 10);
COMMENT ON COLUMN technicians.phone IS '手机号（8.2.2，11 位；没留为空）；页面上打码显示';
COMMENT ON COLUMN technicians.height_cm IS '身高（厘米，8.2.2）；没填为空';
COMMENT ON COLUMN technicians.weight_kg IS '体重（公斤，8.2.2）；没填为空';
COMMENT ON COLUMN technicians.star IS '星级（1–10，8.2.2）：提成可以按星级定；与价格档（等级）分开，价格档照旧决定价格';

-- ── 提成规则按门店：门店为空的是原来全公司一份的（没单独设过的店照旧用它），设过的店用自己的 ──
ALTER TABLE commission_rule_versions ADD COLUMN store_id bigint REFERENCES stores (id);
COMMENT ON COLUMN commission_rule_versions.store_id IS '门店（8.2.2，各店提成不同）；为空是 8.2.2 以前全公司一份的规则，本店没保存过自己的规则时用它';

-- ── 每月业绩任务：按技师或按组设目标金额（分）与目标钟数，报表里看完成度 ──
CREATE TABLE technician_targets (
  id             bigserial PRIMARY KEY,
  store_id       bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  month          date NOT NULL CHECK (extract(day FROM month) = 1),
  technician_id  bigint REFERENCES technicians (id),
  group_id       bigint REFERENCES technician_groups (id),
  amount_cents   bigint NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 100000000000),
  clocks         integer CHECK (clocks IS NULL OR clocks BETWEEN 0 AND 100000),
  updated_by     bigint NOT NULL REFERENCES staff (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technician_targets_one_check CHECK ((technician_id IS NULL) <> (group_id IS NULL))
);
CREATE UNIQUE INDEX technician_targets_tech_uq ON technician_targets (store_id, month, technician_id) WHERE technician_id IS NOT NULL;
CREATE UNIQUE INDEX technician_targets_group_uq ON technician_targets (store_id, month, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX technician_targets_technician_id_fk_idx ON technician_targets (technician_id) WHERE technician_id IS NOT NULL;
CREATE INDEX technician_targets_group_id_fk_idx ON technician_targets (group_id) WHERE group_id IS NOT NULL;
COMMENT ON TABLE technician_targets IS '技师每月业绩任务（8.2.2）：按技师或按组设一个月的目标金额（分）与目标钟数；完成度按结账口径的技师业绩算。改目标是整月替换（审计里留改前改后）';
COMMENT ON COLUMN technician_targets.store_id IS '门店';
COMMENT ON COLUMN technician_targets.month IS '哪个月（当月 1 日）';
COMMENT ON COLUMN technician_targets.technician_id IS '按技师设的：技师；按组设的为空';
COMMENT ON COLUMN technician_targets.group_id IS '按组设的：技师组；按技师设的为空';
COMMENT ON COLUMN technician_targets.amount_cents IS '目标业绩金额（分）';
COMMENT ON COLUMN technician_targets.clocks IS '目标钟数；不设为空';
COMMENT ON COLUMN technician_targets.updated_by IS '设目标的人';
COMMENT ON COLUMN technician_targets.updated_at IS '设目标的时刻';

-- ── 预约记手牌号（一报多：客人已经在店、拿了手牌的可以先写上；没有为空） ──
ALTER TABLE bookings ADD COLUMN tag_code text NOT NULL DEFAULT '' CHECK (tag_code = '' OR tag_code ~ '^[A-Z]{0,2}[0-9]{1,5}$');
COMMENT ON COLUMN bookings.tag_code IS '预约时报的手牌号（8.2.2 一报多，可空）：到店时参考，不锁手牌';

-- ── 新权限「超时退技师」与财务看技师业绩：按部门的岗位从 201 起看库里的建议权限 ──
-- 超时退技师给有「作废与撤销」又能派钟的负责人岗位（前厅、娱乐、康养负责人与总经办）；财务部负责人加「看技师业绩」（原来只有提成）。
-- 门店在「分部门岗位职权配置」里删掉了的岗位不加；每个岗位记一条配置日志（只追加）
INSERT INTO position_config_log (staff_id, action, position_key, detail)
SELECT NULL, 'suggestions', key, '{"added": ["technician.voidLate"], "removed": [], "note": "8.2.2 新权限「超时退技师」（迁移 540）"}'::jsonb
FROM position_catalog WHERE key IN ('ent.lead', 'front.lead', 'gmo', 'wellness.lead') ORDER BY key;
INSERT INTO position_suggestions (position_key, permission)
SELECT key, 'technician.voidLate' FROM position_catalog WHERE key IN ('ent.lead', 'front.lead', 'gmo', 'wellness.lead')
ON CONFLICT DO NOTHING;
INSERT INTO position_config_log (staff_id, action, position_key, detail)
SELECT NULL, 'suggestions', key, '{"added": ["report.technicians"], "removed": [], "note": "8.2.2 财务能看技师业绩（迁移 540）"}'::jsonb
FROM position_catalog WHERE key = 'finance.lead';
INSERT INTO position_suggestions (position_key, permission)
SELECT key, 'report.technicians' FROM position_catalog WHERE key = 'finance.lead'
ON CONFLICT DO NOTHING;
