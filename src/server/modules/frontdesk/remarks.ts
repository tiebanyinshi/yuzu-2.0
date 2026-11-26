// 前台备注（8.1.44《前台系统开发》第 1、8 条，docs/V8144_CASHIER.md）：记经办人与时间，分同组备注与单人备注，可带一个标签
// （客诉、特殊关照……，清单在数据字典 remarkTags，待业务确认）。收银台的「备注」板块与发卡台客人卡上的备注是同一份数据。
// 备注与撤下都只追加（迁移 350 的触发器不许改、不许删）；撤下记原因与经办人，页面上划掉显示。
//
// 锁（docs/LOCKING.md 第 1 节）：
//   · 写一条：来访（共享锁，与同行组的加入、退出、结账对来访的 FOR UPDATE 串行，读到的同行组就是写进去的那个）→ 插入备注；
//     带操作编号（备注表上 op_key 唯一），同一编号重提返回第一次的结果，内容对不上拒绝；
//   · 撤下一条：备注一行（FOR SHARE，读写的人与内容）→ 插入撤下记录，一条只能撤一次靠 remark_id 唯一兜底。

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { MAX_REMARK_LENGTH, MAX_REMARK_TAG_LENGTH, REMARK_SCOPES } from '@shared/frontdesk-remarks';
import { can } from '@shared/permissions';
import { guardAny } from '../../auth/guard';
import { isUniqueViolation } from '../../db';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../../lib/context';
import { conflict, forbidden, unprocessable } from '../../lib/errors';
import { currentStoreId } from '../../lib/store-context';
import { idParam, parse } from '../../lib/validate';
import { businessDate, setTxTimeouts } from './common';
import { getVisit } from './visits';

export const RemarkInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  scope: z.enum(REMARK_SCOPES, '请选择单人备注或同组备注'),
  tag: z.string().trim().max(MAX_REMARK_TAG_LENGTH, `标签最多 ${MAX_REMARK_TAG_LENGTH} 个字`).optional(),
  note: z.string('请填写备注').trim().min(1, '请填写备注').max(MAX_REMARK_LENGTH, `备注最多 ${MAX_REMARK_LENGTH} 字`),
});
export type RemarkInputData = z.input<typeof RemarkInput>;

const RemoveInput = z.object({
  reason: z.string('请填写撤下的原因').trim().min(2, '请填写撤下的原因（至少 2 个字）').max(200, '原因最多 200 字'),
});

/** 写一条备注（带操作编号；同一编号重提返回第一次的结果）。返回这位客人的最新详情 */
export async function addRemark(deps: Deps, visitId: number, raw: RemarkInputData, ctx: OpContext) {
  const input = parse(RemarkInput, raw);
  const tag = input.tag ?? '';
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [visit] = await tx<{ id: number; visitNo: string; status: string; groupId: number | null; tagCode: string }[]>`
      SELECT v.id, v.visit_no, v.status, v.group_id, t.code AS tag_code
      FROM visits v JOIN hand_tags t ON t.id = v.tag_id
      WHERE v.id = ${visitId} AND v.store_id = ${currentStoreId()} FOR SHARE OF v`;
    if (!visit) throw unprocessable('VISIT_NOT_FOUND', '来访记录不存在，请刷新后重试');
    // 原样重提：编号已经记下了，内容一样就返回第一次的结果
    const [prior] = await tx<{ visitId: number; scope: string; tag: string; note: string; createdBy: number }[]>`
      SELECT visit_id, scope, tag, note, created_by FROM visit_remarks WHERE op_key = ${input.clientKey}`;
    if (prior) {
      const same = Number(prior.visitId) === visit.id && prior.scope === input.scope && prior.tag === tag && prior.note === input.note && Number(prior.createdBy) === ctx.actor.id;
      if (!same) throw conflict('IDEMPOTENCY_MISMATCH', '这个操作编号已用于另一条备注，请刷新后重新填写');
      return;
    }
    if (visit.status === 'cancelled') throw conflict('VISIT_CLOSED', `来访 ${visit.visitNo} 已撤销，不能再写备注`);
    if (input.scope === 'group' && !visit.groupId) throw unprocessable('NO_GROUP', `手牌 ${visit.tagCode} 没有同行，请写单人备注`);
    const at = ctx.at ?? new Date();
    const groupId = input.scope === 'group' ? visit.groupId : null;
    let id: number;
    try {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO visit_remarks (visit_id, scope, group_id, tag, note, op_key, created_by, created_at)
        VALUES (${visit.id}, ${input.scope}, ${groupId}, ${tag}, ${input.note}, ${input.clientKey}, ${ctx.actor.id}, ${at})
        RETURNING id`;
      id = Number(row!.id);
    } catch (e) {
      // 同一编号的另一次提交刚写进去：让页面原样重提一次就能对上
      if (isUniqueViolation(e)) throw conflict('IN_PROGRESS', '这条备注正在保存，请稍后刷新');
      throw e;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'visit_remark',
      targetType: 'visit',
      targetId: visit.id,
      detail: { visitNo: visit.visitNo, tagCode: visit.tagCode, remarkId: id, scope: input.scope, ...(groupId ? { groupId } : {}), tag, note: input.note },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return getVisit(deps.sql, visitId, deps.config.timezone);
}

/** 撤下一条备注：写的人自己，或有「作废他人或超时明细」权限的人（值班经理及以上）。返回打开的这位客人的最新详情 */
export async function removeRemark(deps: Deps, remarkId: number, visitId: number, raw: unknown, ctx: OpContext) {
  const input = parse(RemoveInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [r] = await tx<{ id: number; visitId: number; createdBy: number; tag: string; note: string; scope: string; visitNo: string }[]>`
      SELECT r.id, r.visit_id, r.created_by, r.tag, r.note, r.scope, v.visit_no
      FROM visit_remarks r JOIN visits v ON v.id = r.visit_id
      WHERE r.id = ${remarkId} AND r.store_id = ${currentStoreId()} FOR SHARE OF r`;
    if (!r) throw unprocessable('REMARK_NOT_FOUND', '这条备注不存在，请刷新后重试');
    if (Number(r.createdBy) !== ctx.actor.id && !can(ctx.actor, 'frontdesk.correct')) throw forbidden('不是你写的备注，请由写的人或值班经理撤下');
    const at = ctx.at ?? new Date();
    try {
      await tx`INSERT INTO visit_remark_removals (remark_id, reason, created_by, created_at) VALUES (${r.id}, ${input.reason}, ${ctx.actor.id}, ${at})`;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('REMARK_REMOVED', '这条备注已经撤下了，请刷新');
      throw e;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'visit_remark_removed',
      targetType: 'visit',
      targetId: Number(r.visitId),
      detail: { visitNo: r.visitNo, remarkId: Number(r.id), scope: r.scope, tag: r.tag, note: r.note, reason: input.reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return getVisit(deps.sql, visitId, deps.config.timezone);
}

export function registerRemarkRoutes(app: FastifyInstance, deps: Deps) {
  // 发卡台、收银台都能写（收银的人可能只有结账权限）
  app.post('/api/frontdesk/visits/:id/remarks', { preHandler: guardAny('frontdesk.operate', 'frontdesk.checkout') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return addRemark(deps, id, req.body as RemarkInputData, ctxOf(req));
  });
  // 撤下：带上现在打开的是哪位客人（同组备注从组里任何一位客人那里撤），返回这位客人的详情
  app.post('/api/frontdesk/remarks/:id/remove', { preHandler: guardAny('frontdesk.operate', 'frontdesk.checkout') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { visitId } = parse(z.object({ visitId: z.number().int().positive() }), { visitId: (req.body as { visitId?: unknown } | null)?.visitId });
    return removeRemark(deps, id, visitId, req.body, ctxOf(req));
  });
}
