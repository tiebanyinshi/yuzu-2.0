// 排位调到指定位置（8.1.40，docs/V8140_B.md 第 3 节）：把一位在岗技师直接调到同工种另一位在岗技师的前面。
// 以前只有「排到队尾」；店员要把叫回来的、补位的人插到某人前面时只能一个个排尾，现在一步调好。
//
// 排位就是 technician_status.queue_key（越早越靠前，同一时刻按技师编号）。调到 B 前面：把 A 的 queue_key 改成 B 的减 1 毫秒；
// B 前面那位与 B 之间挤不下（相差不到 2 毫秒、同一时刻）时，从 A 往前依次把挤着的人各提前 1 毫秒——只往前挪、相对顺序不变，
// B 和 B 后面的人一个都不动。排位按工种分开（8.1.38），所以只能调到同工种的人前面。
// 锁：与排到队尾相同，只拿技师队列锁再写技师状态（docs/LOCKING.md 第 1 节钟房）。
// 带操作编号（与休假、停牌、复牌同一类 technician_state，合并前 Codex 审查 fca1ba4）：结果不明时页面留着原请求，查回、原样重提或确认作废；
// 不然超时的那一笔迟到生效，会把之后另调的顺序盖掉。同一编号原样重提返回当前看板（已经调过的不再调），确认作废的编号迟到也不生效。

import { z } from 'zod';
import type { Tx } from '../db';
import type { Deps, OpContext } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { currentStoreId } from '../lib/store-context';
import { businessDate, hashRequest, runIdempotent, saveKey, setTxTimeouts } from './frontdesk/common';
import { loadTechnicians } from './technicians';
import { clockroomBoard, lockQueue, logEvent, offStatus, queueKindOf, queueOrderOfKind, statusMap, writeStatus, type Status } from './clockroom';

export const MoveBeforeInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  /** 调到这位技师的前面 */
  beforeId: z.number('请选调到哪位技师前面').int().positive('请选调到哪位技师前面'),
  reason: z.string().trim().max(100, '原因最多 100 字').optional(),
});

/**
 * 按调好以后的顺序算新的 queue_key：order 是调好以后同工种的顺序（mover 已经插在 before 前面），
 * 返回要改的技师 → 新的 queue_key（不用改的不在里面）。只往前挪，不动 before 和后面的人
 */
export function moveBeforeKeys(order: number[], keys: Map<number, number>, moverId: number): Map<number, number> {
  const at = order.indexOf(moverId);
  const out = new Map<number, number>();
  if (at < 0 || at === order.length - 1) return out;
  let next = keys.get(order[at + 1]!)!;
  const mover = next - 1;
  if (keys.get(moverId) !== mover) out.set(moverId, mover);
  next = mover;
  for (let i = at - 1; i >= 0; i--) {
    const id = order[i]!;
    const k = keys.get(id)!;
    if (k < next) break; // 已经排在前面了：再往前的也都对
    next -= 1;
    out.set(id, next);
  }
  return out;
}

/** 把 technicianId 调到 beforeId 前面（同工种、两位都在岗）；原因必填，记进钟房日志「调整排位」 */
export async function moveBefore(deps: Deps, technicianId: number, raw: unknown, ctx: OpContext) {
  const { clientKey, beforeId, reason = '' } = parse(MoveBeforeInput, raw);
  if (reason.length < 2) throw unprocessable('REASON_REQUIRED', '调位请写原因（至少 2 个字，例如：客人等着先叫他、补回刚才跳过的）');
  if (beforeId === technicianId) throw unprocessable('MOVE_SELF', '不能调到自己前面，请选另一位技师');
  const requestHash = hashRequest({ technicianId, moveBefore: beforeId, reason });
  await runIdempotent(deps, { key: clientKey, opType: 'technician_state', requestHash }, async (tx) => {
    await apply(tx);
    await saveKey(tx, clientKey, 'technician_state', requestHash, technicianId, ctx.actor.id);
    return technicianId;
  });
  return clockroomBoard(deps.sql, deps);

  async function apply(tx: Tx) {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    await lockQueue(tx);
    const techs = await loadTechnicians(tx);
    const me = techs.get(technicianId);
    const target = techs.get(beforeId);
    const [own] = await tx<{ id: number }[]>`SELECT id FROM technicians WHERE id = ${technicianId} AND store_id = ${currentStoreId()}`;
    if (!me || !own) throw notFound('技师不存在');
    if (!target) throw notFound('要调到前面的那位技师不存在，请刷新');
    const label = `${me.techNo} 号 ${me.name}`;
    const targetLabel = `${target.techNo} 号 ${target.name}`;
    const today = await businessDate(tx, deps, at);
    const statuses = await statusMap(tx, today);
    const mine: Status = statuses.get(me.id) ?? offStatus;
    const theirs: Status = statuses.get(target.id) ?? offStatus;
    if (mine.state !== 'on') throw conflict('NOT_ON', `${label}不在岗（暂离、休假、未上牌的不在排位里），不能调位`);
    if (theirs.state !== 'on') throw conflict('TARGET_NOT_ON', `${targetLabel}不在排位里（暂离、休假、未上牌），请选在岗的技师`);
    const kind = queueKindOf(techs, me.id);
    const kindOfTarget = queueKindOf(techs, target.id);
    if (kind !== kindOfTarget) {
      throw unprocessable('QUEUE_KIND_MISMATCH', `${label}是「${kind || '未分工种'}」，${targetLabel}是「${kindOfTarget || '未分工种'}」：排位按工种分开，只能调到同工种的技师前面`);
    }
    const current = queueOrderOfKind(statuses, techs, kind);
    const rest = current.filter((id) => id !== me.id);
    const order = [...rest.slice(0, rest.indexOf(target.id)), me.id, ...rest.slice(rest.indexOf(target.id))];
    // 已经就在他前面：不改、不记日志
    if (order.every((id, i) => id === current[i])) return;
    const keys = new Map(order.map((id) => [id, statuses.get(id)!.queueKey!.getTime()]));
    for (const [id, key] of moveBeforeKeys(order, keys, me.id)) {
      await writeStatus(tx, id, today, { ...statuses.get(id)!, queueKey: new Date(key) }, ctx.actor.id, at);
    }
    await logEvent(tx, { technicianId: me.id, kind: 'queue', detail: { reason, before: target.techNo }, staffId: ctx.actor.id, businessDate: today, at });
  }
}
