// 报销不自动通过（8.2.6，《业财法审批与 WCP 需求变更》B1、7.3、7.4）：查不到审批人时告警；没经过审批就通过的历史清单。
// 报销的登记、审批在 expenses.ts。

import { formatAmount } from '@shared/money';
import type { Db, Tx } from '../db';
import { toCsv } from '../lib/csv';
import { pendingStuck } from './approvals';
import { notify } from './oa';

const yuan = (cents: number) => (cents < 0 ? '-' : '') + formatAmount(Math.abs(cents)).replace(/,/g, '');

// ───────────────────────── 查不到审批人（8.2.6，B1 / 7.3 第 2 条） ─────────────────────────

/** 报销单刚提交、这一级没有人能审：单据照样停在待审（不自动通过），通知店主去「审批规则」里配 */
export async function alertIfNoApprover(tx: Tx, claimId: number, docNo: string) {
  if (!(await pendingStuck(tx, 'expense_claim', claimId))) return;
  const owners = await tx<{ id: number }[]>`SELECT id FROM staff WHERE active AND role = 'owner'`;
  await notify(
    tx,
    owners.map((o) => Number(o.id)),
    { kind: 'system', title: `报销单 ${docNo} 没有能审批的人`, body: '这张报销单停在待审，不会自动通过。请在 ERP「审批中心 → 审批规则」里给报销配审批人，或给负责人开「确认报销」权限。' },
  );
}

/**
 * 没经过审批就通过了的报销（8.2.6，《业财法审批与 WCP 需求变更》7.4）：交财务确认后再定补审、标异常或批量注明（Q8）。
 * ERP 费用报销：已确认、但「登记即确认」（needs_approval = false）、确认人就是登记人、或确认早于登记；
 * WCP 审批里的报销：已通过、一级审批都没有。只读，不改任何单据
 */
async function autoApprovedRows(db: Db) {
  const erp = await db<{ docNo: string; department: string; creator: string; amountCents: number; createdAt: string; confirmedAt: string | null; confirmer: string | null; issue: string }[]>`
    SELECT c.doc_no, d.name AS department, cs.display_name AS creator, c.amount_cents, to_char(c.created_at, 'YYYY-MM-DD HH24:MI') AS created_at, to_char(c.confirmed_at, 'YYYY-MM-DD HH24:MI') AS confirmed_at, fs.display_name AS confirmer,
           CASE WHEN NOT c.needs_approval THEN '未超过门槛，登记即确认（没有审批）'
                WHEN c.confirmed_by = c.created_by THEN '登记人自己确认'
                ELSE '确认时间早于登记时间' END AS issue
    FROM expense_claims c JOIN departments d ON d.id = c.department_id JOIN staff cs ON cs.id = c.created_by LEFT JOIN staff fs ON fs.id = c.confirmed_by
    WHERE c.status = 'confirmed' AND (NOT c.needs_approval OR c.confirmed_by = c.created_by OR c.confirmed_at < c.created_at)
    ORDER BY c.created_at`;
  const wcp = await db<{ id: number; title: string; applicant: string; amount: unknown; createdAt: string; finishedAt: string | null }[]>`
    SELECT a.id, a.title, s.display_name AS applicant, a.form->'amount' AS amount, to_char(a.submitted_at, 'YYYY-MM-DD HH24:MI') AS created_at, to_char(a.finished_at, 'YYYY-MM-DD HH24:MI') AS finished_at
    FROM oa_approvals a JOIN staff s ON s.id = a.applicant_id
    WHERE a.template_code = 'expense' AND a.status = 'approved' AND NOT EXISTS (SELECT 1 FROM oa_approval_steps t WHERE t.approval_id = a.id)
    ORDER BY a.submitted_at`;
  return { erp, wcp };
}

export async function autoApprovedCsv(db: Db) {
  const { erp, wcp } = await autoApprovedRows(db);
  return toCsv([
    [`没经过审批就通过的报销（ERP 费用报销 ${erp.length} 张、WCP 审批报销 ${wcp.length} 张；交财务确认处理方式）`],
    ['来源', '单号', '部门', '登记人 / 发起人', '金额（元）', '登记时间', '通过时间', '确认人', '问题'],
    ...erp.map((r) => ['ERP 费用报销', r.docNo, r.department, r.creator, yuan(Number(r.amountCents)), r.createdAt, r.confirmedAt ?? '', r.confirmer ?? '', r.issue]),
    ...wcp.map((r) => [
      'WCP 审批 · 报销',
      `OA-${r.id} ${r.title}`,
      '',
      r.applicant,
      typeof r.amount === 'number' ? yuan(r.amount) : '',
      r.createdAt,
      r.finishedAt ?? '',
      '',
      '发起人就是最上级，没有审批直接通过',
    ]),
  ]);
}
