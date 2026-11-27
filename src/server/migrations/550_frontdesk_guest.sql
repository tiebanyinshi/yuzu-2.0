-- 8.2.3 前台（发卡台与全店，docs/V8223_FRONTDESK.md）：会议纪要《会所管理系统演示与需求讨论》（2026-11-26）前台的九条。
--   · visits.guest_category：客人类别（普通、港客、外宾、儿童，后台可加；记的是字，清单改了以前记的照旧显示原来的字）；
--   · visit_category_changes：发牌以后改类别的记录（只追加）；
--   · guest_preferences：客人偏好（忌口、按摩力度……，字段在后台加）：会员的记在会员上（下次来自动带出），散客的记在这一次来访上；
--   · visit_remark_resolutions：客诉台账里标「已处理」（只追加，一条备注只能标一次）；
--   · visit_risk_alerts：高风险提示推送过的记录（每位客人每一样只推一次）；
--   · bill_supplements：补单（按实际时间、出单员补录的挂账）记出单员，明细与 backfill_entries 照旧；
--   · 权限：新增「技师预约」「补单」「客诉台账」。原来有「预约」的岗位（前台收银员、前厅部员工除外——店主 2026-11-26「技师预约权限不给前台」）
--     加上「技师预约」；后台「岗位权限」、个人微调里加了「预约」的一起加上，去掉了「预约」的一起去掉（宁少不多）。
-- 风险已知：只加列、加表、加建议权限；visits 加的列有默认值，已有的来访一行不改内容。
-- 回滚：docs/rollback/550_frontdesk_guest.down.sql。

-- ───────────── 1. 客人类别 ─────────────
ALTER TABLE visits ADD COLUMN guest_category text NOT NULL DEFAULT '' CHECK (char_length(guest_category) <= 8);
COMMENT ON COLUMN visits.guest_category IS '客人类别（8.2.3）：发牌时选的（普通、港客、外宾、儿童……，后台「客人与提醒」的清单）；空 = 默认类别（升级前的来访）';

CREATE TABLE visit_category_changes (
  id            bigserial PRIMARY KEY,
  visit_id      bigint NOT NULL REFERENCES visits (id),
  from_category text NOT NULL CHECK (char_length(from_category) <= 8),
  to_category   text NOT NULL CHECK (char_length(to_category) <= 8),
  operator_id   bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visit_category_changes_visit_idx ON visit_category_changes (visit_id, id);
CREATE TRIGGER visit_category_changes_append_only BEFORE UPDATE OR DELETE ON visit_category_changes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
COMMENT ON TABLE visit_category_changes IS '发牌以后改客人类别的记录（8.2.3，只追加）：进这次来访的经办记录';
COMMENT ON COLUMN visit_category_changes.visit_id IS '哪一次来访';
COMMENT ON COLUMN visit_category_changes.from_category IS '原来的类别（空 = 默认类别）';
COMMENT ON COLUMN visit_category_changes.to_category IS '改成的类别';
COMMENT ON COLUMN visit_category_changes.operator_id IS '经办人';
COMMENT ON COLUMN visit_category_changes.created_at IS '改的时间';

-- ───────────── 2. 客人偏好 ─────────────
CREATE TABLE guest_preferences (
  id          bigserial PRIMARY KEY,
  member_id   bigint REFERENCES members (id),
  visit_id    bigint REFERENCES visits (id),
  field_key   text NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_]{0,19}$'),
  value       text NOT NULL CHECK (char_length(value) <= 60),
  updated_by  bigint NOT NULL REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((member_id IS NULL) <> (visit_id IS NULL))
);
CREATE UNIQUE INDEX guest_preferences_member_uq ON guest_preferences (member_id, field_key) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX guest_preferences_visit_uq ON guest_preferences (visit_id, field_key) WHERE visit_id IS NOT NULL;
CREATE INDEX guest_preferences_updated_by_fk_idx ON guest_preferences (updated_by);
COMMENT ON TABLE guest_preferences IS '客人偏好（8.2.3）：忌口、按摩力度等（字段在后台「客人与提醒」）。会员的记在会员上、跟着会员走；散客的记在这次来访上。一格一行，清空就删掉这一行（改动记审计）';
COMMENT ON COLUMN guest_preferences.member_id IS '会员（会员的偏好）；散客为空';
COMMENT ON COLUMN guest_preferences.visit_id IS '来访（散客的偏好）；会员为空';
COMMENT ON COLUMN guest_preferences.field_key IS '字段编号（后台字段的 key，改名不丢值）';
COMMENT ON COLUMN guest_preferences.value IS '填的内容（最多 60 字）';
COMMENT ON COLUMN guest_preferences.updated_by IS '最后改的人';
COMMENT ON COLUMN guest_preferences.updated_at IS '最后改的时间';

-- ───────────── 3. 客诉台账：标已处理 ─────────────
CREATE TABLE visit_remark_resolutions (
  id          bigserial PRIMARY KEY,
  remark_id   bigint NOT NULL UNIQUE REFERENCES visit_remarks (id),
  note        text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 200),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visit_remark_resolutions_created_by_fk_idx ON visit_remark_resolutions (created_by);
CREATE TRIGGER visit_remark_resolutions_append_only BEFORE UPDATE OR DELETE ON visit_remark_resolutions
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
COMMENT ON TABLE visit_remark_resolutions IS '客诉台账（8.2.3）：带「客诉」「特殊关照」等标签的前台备注标「已处理」（只追加，一条备注只能标一次）';
COMMENT ON COLUMN visit_remark_resolutions.remark_id IS '哪一条前台备注';
COMMENT ON COLUMN visit_remark_resolutions.note IS '处理结果';
COMMENT ON COLUMN visit_remark_resolutions.created_by IS '标已处理的人';
COMMENT ON COLUMN visit_remark_resolutions.created_at IS '标已处理的时间';

-- ───────────── 4. 高风险提示的推送记录 ─────────────
CREATE TABLE visit_risk_alerts (
  id            bigserial PRIMARY KEY,
  visit_id      bigint NOT NULL REFERENCES visits (id),
  reason        text NOT NULL CHECK (reason IN ('stay', 'amount')),
  threshold     bigint NOT NULL CHECK (threshold > 0),
  observed      bigint NOT NULL CHECK (observed >= 0),
  notify_level  text NOT NULL CHECK (notify_level IN ('duty_manager', 'store_manager')),
  recipients    integer NOT NULL CHECK (recipients >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (visit_id, reason)
);
COMMENT ON TABLE visit_risk_alerts IS '高风险提示推送过的记录（8.2.3）：在店超过设定小时数、挂账超过设定金额时推给值班经理或店总（站内通知），每位客人每一样只推一次';
COMMENT ON COLUMN visit_risk_alerts.visit_id IS '哪一次来访';
COMMENT ON COLUMN visit_risk_alerts.reason IS 'stay 在店时间长 / amount 挂账金额大';
COMMENT ON COLUMN visit_risk_alerts.threshold IS '推的时候的阈值：stay 是小时数，amount 是金额（分）';
COMMENT ON COLUMN visit_risk_alerts.observed IS '推的时候的实际值：stay 是在店分钟数，amount 是挂账金额（分）';
COMMENT ON COLUMN visit_risk_alerts.notify_level IS '推给谁：duty_manager 值班经理及以上 / store_manager 店总及店主';
COMMENT ON COLUMN visit_risk_alerts.recipients IS '推给了几个人';
COMMENT ON COLUMN visit_risk_alerts.created_at IS '推的时间';

-- ───────────── 5. 补单 ─────────────
CREATE TABLE bill_supplements (
  id          bigserial PRIMARY KEY,
  op_key      uuid NOT NULL UNIQUE,
  visit_id    bigint NOT NULL REFERENCES visits (id),
  issuer_id   bigint NOT NULL REFERENCES staff (id),
  actual_at   timestamptz NOT NULL,
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bill_supplements_visit_idx ON bill_supplements (visit_id);
CREATE INDEX bill_supplements_issuer_id_fk_idx ON bill_supplements (issuer_id);
CREATE INDEX bill_supplements_created_by_fk_idx ON bill_supplements (created_by);
CREATE TRIGGER bill_supplements_append_only BEFORE UPDATE OR DELETE ON bill_supplements
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
COMMENT ON TABLE bill_supplements IS '补单（8.2.3）：有「补单」权限的人按实际时间、出单员给在店客人补录的挂账（餐饮不打厨房单）；明细（bill_lines.post_key = op_key）与 backfill_entries 照旧记';
COMMENT ON COLUMN bill_supplements.op_key IS '这一笔挂账的操作编号（= bill_lines.post_key）';
COMMENT ON COLUMN bill_supplements.visit_id IS '补到哪一次来访';
COMMENT ON COLUMN bill_supplements.issuer_id IS '出单员（实际下单、开单的人）';
COMMENT ON COLUMN bill_supplements.actual_at IS '实际时间（明细的 posted_at 也是它）';
COMMENT ON COLUMN bill_supplements.created_by IS '录入补单的人';
COMMENT ON COLUMN bill_supplements.created_at IS '录入时间';

-- ───────────── 6. 权限 ─────────────
-- 一份增减（{add, remove}）：去掉了「预约」的，也去掉「技师预约」；加了「预约」的（give = 这个岗位要给），加上「技师预约」
CREATE FUNCTION pg_temp.yuzu_v8223_adjust(cfg jsonb, give boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a jsonb; r jsonb;
BEGIN
  IF cfg IS NULL OR jsonb_typeof(cfg) <> 'object' THEN RETURN cfg; END IF;
  a := CASE WHEN jsonb_typeof(cfg -> 'add') = 'array' THEN cfg -> 'add' END;
  r := CASE WHEN jsonb_typeof(cfg -> 'remove') = 'array' THEN cfg -> 'remove' END;
  IF r IS NOT NULL AND r ? 'booking.manage' AND NOT r ? 'booking.technician' THEN
    cfg := jsonb_set(cfg, '{remove}', r || '["booking.technician"]'::jsonb);
  ELSIF give AND a IS NOT NULL AND a ? 'booking.manage' AND NOT a ? 'booking.technician' THEN
    cfg := jsonb_set(cfg, '{add}', a || '["booking.technician"]'::jsonb);
  END IF;
  RETURN cfg;
END $$;

-- 后台「岗位权限」：旧岗位（收银员 clerk 不给）、新岗位（前厅部员工 front.staff 不给）
UPDATE settings s SET value = (SELECT jsonb_object_agg(e.k, pg_temp.yuzu_v8223_adjust(e.v, e.k <> 'clerk')) FROM jsonb_each(s.value) AS e(k, v))
WHERE s.key = 'role_permissions' AND jsonb_typeof(s.value) = 'object' AND s.value <> '{}'::jsonb AND s.value::text LIKE '%"booking.manage"%';
UPDATE settings s SET value = (SELECT jsonb_object_agg(e.k, pg_temp.yuzu_v8223_adjust(e.v, e.k <> 'front.staff')) FROM jsonb_each(s.value) AS e(k, v))
WHERE s.key = 'position_permissions' AND jsonb_typeof(s.value) = 'object' AND s.value <> '{}'::jsonb AND s.value::text LIKE '%"booking.manage"%';
-- 员工档案里的个人微调：单独给某人加的「预约」保持原来的能力
UPDATE staff SET permission_adjust = pg_temp.yuzu_v8223_adjust(permission_adjust, true) WHERE permission_adjust::text LIKE '%"booking.manage"%';

-- 岗位的建议权限（「分部门岗位职权配置」）：有「预约」的岗位（前厅部员工除外）加「技师预约」；有「补录纸质单」的岗位加「补单」「客诉台账」。
-- 每个岗位记一条配置日志（只追加）
INSERT INTO position_config_log (staff_id, action, position_key, detail)
SELECT NULL, 'suggestions', k.position_key,
       jsonb_build_object('added', to_jsonb(k.added), 'removed', '[]'::jsonb, 'note', '8.2.3 前台：技师预约单独一项（前厅部员工没有）、补单、客诉台账（迁移 550）')
FROM (
  SELECT position_key, array_agg(p ORDER BY p) AS added FROM (
    SELECT position_key, 'booking.technician' AS p FROM position_suggestions WHERE permission = 'booking.manage' AND position_key <> 'front.staff'
    UNION SELECT position_key, 'frontdesk.supplement' FROM position_suggestions WHERE permission = 'frontdesk.backfill'
    UNION SELECT position_key, 'frontdesk.complaints' FROM position_suggestions WHERE permission = 'frontdesk.backfill'
  ) x
  WHERE NOT EXISTS (SELECT 1 FROM position_suggestions s WHERE s.position_key = x.position_key AND s.permission = x.p)
  GROUP BY position_key
) k ORDER BY k.position_key;
INSERT INTO position_suggestions (position_key, permission)
SELECT position_key, 'booking.technician' FROM position_suggestions WHERE permission = 'booking.manage' AND position_key <> 'front.staff'
ON CONFLICT DO NOTHING;
INSERT INTO position_suggestions (position_key, permission)
SELECT position_key, p FROM position_suggestions CROSS JOIN unnest(ARRAY['frontdesk.supplement', 'frontdesk.complaints']) AS p WHERE permission = 'frontdesk.backfill'
ON CONFLICT DO NOTHING;

DROP FUNCTION pg_temp.yuzu_v8223_adjust(jsonb, boolean);
