-- 回测整改 P09（回测 4-2，docs/YUZU_REQ_V820.md 第 10 节，RT21 起）：新权限「技师上钟轮播」（technician.board，只读大屏）。
-- 按岗位的默认（店长、值班经理有，代码里的 PERMISSIONS）不用迁移；按部门的岗位从 201 起看库里的建议权限，
-- 这里给建议权限里有「排位播报」的岗位（排位员所在的岗位：前台、娱乐部、康养部等）加上它，每个岗位记一条配置日志（只追加）。
-- 门店在「分部门岗位职权配置」里改过、去掉了「排位播报」的岗位不加。
-- 回滚：docs/rollback/203_technician_board.down.sql（删掉这一项建议权限；日志只追加，留着）。

INSERT INTO position_suggestions (position_key, permission)
SELECT position_key, 'technician.board' FROM position_suggestions WHERE permission = 'technician.announce'
ON CONFLICT DO NOTHING;

INSERT INTO position_config_log (staff_id, action, position_key, detail)
SELECT NULL, 'suggestions', position_key, '{"added": ["technician.board"], "removed": [], "note": "回测整改新权限「技师上钟轮播」：给有「排位播报」的岗位加上（迁移 203）"}'::jsonb
FROM position_suggestions WHERE permission = 'technician.announce' ORDER BY position_key;
