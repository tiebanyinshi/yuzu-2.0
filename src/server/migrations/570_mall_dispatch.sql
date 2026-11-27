-- 8.2.5 采购商城 v0.2（店主 2026-11-27《汤崎 ERP｜采购商城模块 需求变更文档 v0.2》，设计见 docs/MALL_V825.md）：
-- 分批发配与物料发配记录、退回逐项标「本次必补」、每次提交的版本快照、终止申购（部门负责人或 BP 确认）、收货的「待判」数量。
-- 风险已知：只加表、加列，不改已有数据（只把核库已开的领料单抄一份进发配记录）；回滚见 docs/rollback/570_mall_dispatch.down.sql。

-- 发配记录：库管把物料给到申请部门的每一次（开的都是部门领料单）。核库时领用的是第一次（stock），
-- 采购到货以后在「物料发配记录」里点「补发物料」的是后面几次（arrival）。已发配量 = 这里的合计（领料单作废的不算）
CREATE TABLE request_line_issues (
  id              bigserial PRIMARY KEY,
  request_line_id bigint NOT NULL REFERENCES purchase_request_lines (id),
  request_id      bigint NOT NULL REFERENCES purchase_requests (id),
  department_id   bigint NOT NULL REFERENCES departments (id),
  inv_doc_id      bigint NOT NULL REFERENCES inv_docs (id),
  qty_milli       bigint NOT NULL CHECK (qty_milli > 0),
  kind            text NOT NULL CHECK (kind IN ('stock', 'arrival')),
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  created_by      bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inv_doc_id, request_line_id)
);
CREATE INDEX request_line_issues_request_line_id_fk_idx ON request_line_issues (request_line_id);
CREATE INDEX request_line_issues_request_id_fk_idx ON request_line_issues (request_id);
CREATE INDEX request_line_issues_department_id_fk_idx ON request_line_issues (department_id);
CREATE INDEX request_line_issues_created_at_idx ON request_line_issues (created_at);
COMMENT ON TABLE request_line_issues IS '物料发配记录（8.2.5）：需求行每一次给到部门的数量与领料单；stock 核库时领用，arrival 到货后补发';
COMMENT ON COLUMN request_line_issues.qty_milli IS '这一次发配的数量（需求行的单位，千分之一）';
COMMENT ON COLUMN request_line_issues.kind IS 'stock 核库时从库存发；arrival 采购到货后在物料发配记录里补发';
COMMENT ON COLUMN request_line_issues.inv_doc_id IS '开的部门领料单（作废了的这一条不算已发配）';

-- 已有的核库领用抄一份进发配记录（一行一条）
INSERT INTO request_line_issues (request_line_id, request_id, department_id, inv_doc_id, qty_milli, kind, note, created_by, created_at)
SELECT s.request_line_id, s.request_id, r.department_id, s.inv_doc_id, s.issued_qty_milli, 'stock', '核库领用', s.decided_by, s.decided_at
FROM request_line_stock s JOIN purchase_requests r ON r.id = s.request_id
WHERE s.inv_doc_id IS NOT NULL AND s.issued_qty_milli > 0;

-- 退回时逐项标的「本次必补」：哪一行、哪一项、原来填的、要补什么；补齐重提时记下补的内容。一次退回是一轮（round）
CREATE TABLE request_fix_items (
  id              bigserial PRIMARY KEY,
  request_id      bigint NOT NULL REFERENCES purchase_requests (id),
  round           integer NOT NULL CHECK (round > 0),
  request_line_id bigint REFERENCES purchase_request_lines (id) ON DELETE SET NULL,
  line_label      text NOT NULL DEFAULT '' CHECK (char_length(line_label) <= 120),
  field_key       text NOT NULL CHECK (char_length(field_key) BETWEEN 1 AND 40),
  original_value  text NOT NULL DEFAULT '' CHECK (char_length(original_value) <= 1000),
  requirement     text NOT NULL CHECK (char_length(requirement) BETWEEN 1 AND 200),
  supplied_value  text CHECK (supplied_value IS NULL OR char_length(supplied_value) <= 2000),
  returned_by     bigint NOT NULL REFERENCES staff (id),
  returned_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX request_fix_items_request_id_fk_idx ON request_fix_items (request_id, round);
CREATE INDEX request_fix_items_request_line_id_fk_idx ON request_fix_items (request_line_id);
COMMENT ON TABLE request_fix_items IS '退回补资料的「本次必补」（8.2.5）：退回时逐项标出要补什么，补齐重提时记下补的内容；多轮退回各自一轮';
COMMENT ON COLUMN request_fix_items.field_key IS '要补的项（src/shared/mall-fix.ts 的 MALL_FIX_FIELDS）';
COMMENT ON COLUMN request_fix_items.line_label IS '退回时那一行的名称（行删了也看得到是哪一行）';
COMMENT ON COLUMN request_fix_items.original_value IS '退回时原来填的（补资料页灰字回显）';

-- 每次提交的完整内容（V1 第一次提交，之后每次补资料重提加一版）；只追加
CREATE TABLE purchase_request_versions (
  request_id  bigint NOT NULL REFERENCES purchase_requests (id),
  version_no  integer NOT NULL CHECK (version_no > 0),
  snapshot    jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  mode        text NOT NULL CHECK (mode IN ('submit', 'fix', 'rewrite', 'baseline')),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, version_no)
);
COMMENT ON TABLE purchase_request_versions IS '商城需求单每次提交的完整版本快照（8.2.5）：V1、V2……只读可查';
COMMENT ON COLUMN purchase_request_versions.mode IS 'submit 第一次提交；fix 只补必补项；rewrite 重新填写；baseline 升级前已提交的单第一次补资料时补记的原版本';

-- 终止申购：提单人申请，部门负责人或供应链 BP 确认（店主 2026-11-27 Q5 按建议）；负责人、BP、店主自己提的直接终止
CREATE TABLE request_terminations (
  request_id   bigint PRIMARY KEY REFERENCES purchase_requests (id),
  reason       text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 200),
  status       text NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
  requested_by bigint NOT NULL REFERENCES staff (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by   bigint REFERENCES staff (id),
  decided_at   timestamptz,
  decide_note  text NOT NULL DEFAULT '' CHECK (char_length(decide_note) <= 200),
  CHECK ((status = 'pending') = (decided_by IS NULL))
);
COMMENT ON TABLE request_terminations IS '终止申购（8.2.5）：提单人申请、部门负责人或供应链 BP 确认；确认后需求单定为已撤回（显示「已终止」）';

-- 收货的「待判」：货到了还没验完、暂不入库的数量（送达 = 合格 + 拒收 + 待判，店主 2026-11-27 Q10 按建议拆成两项：待补发记在 redeliver_milli）
ALTER TABLE inv_doc_lines ADD COLUMN hold_milli bigint NOT NULL DEFAULT 0 CHECK (hold_milli >= 0);
COMMENT ON COLUMN inv_doc_lines.hold_milli IS '收货里待判 / 待检、暂不入库的数量（库存单位千分；8.2.5）；验完以后合格的再做一张收货单';

-- 补发物料、终止申购的「结果待确认」：各用自己的操作类型（在当时的约束上追加，与 520 同一写法）
DO $$
DECLARE
  t text;
  expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression
      FROM pg_constraint
     WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN
      RAISE EXCEPTION '找不到 %.%_op_type_check 约束', t, t;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''request_dispatch'', ''mall_terminate''))',
      t,
      t || '_op_type_check',
      expression
    );
  END LOOP;
END $$;
