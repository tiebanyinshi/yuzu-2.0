-- 8.1.36（docs/LINGYU_AUDIT_V8136.md 第 2 节）：新权限「餐饮台账」（dining.ledger）——全店每道菜的明细、金额、退菜与导出，
-- 以前凡有「餐饮点单」的都能看，改成值班经理及以上（代码里的 PERMISSIONS，不用迁移）与按部门岗位里的总经办、前厅部、餐饮部、康美部负责人。
-- 按部门的岗位从 201 起看库里的建议权限：这里给这四个岗位加上（门店在「分部门岗位职权配置」里去掉了「餐饮点单」的不加），
-- 每个岗位记一条配置日志（只追加）。
-- 回滚：docs/rollback/280_dining_ledger.down.sql（删掉这一项建议权限；日志只追加，留着）。

INSERT INTO position_suggestions (position_key, permission)
SELECT position_key, 'dining.ledger' FROM position_suggestions
WHERE permission = 'dining.order' AND position_key IN ('gmo', 'front.lead', 'dining.lead', 'kangmei.lead')
ON CONFLICT DO NOTHING;

INSERT INTO position_config_log (staff_id, action, position_key, detail)
SELECT NULL, 'suggestions', position_key, '{"added": ["dining.ledger"], "removed": [], "note": "8.1.36 新权限「餐饮台账」：给总经办与前厅、餐饮、康美负责人加上（迁移 280）"}'::jsonb
FROM position_suggestions WHERE permission = 'dining.ledger' ORDER BY position_key;
