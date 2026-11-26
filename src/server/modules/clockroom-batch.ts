// 一次给多张手牌派钟（8.1.40，docs/V8140_B.md 第 4 节）：一个操作编号、一个事务，最多 10 条，全部生效或全部不生效。
//
// 每一条与单张派钟（POST /api/clockroom/dispatch）走同一个挂账入口 postChargesTx：价格档、技师能不能做、轮钟排位与跳过原因、
// 技师预约、房间、预约到店，规则一条不少；前一条派出去的技师在后一条里已经在钟上（同一个事务里看得到）。
// 顺序固定：按来访编号从小到大（同一位客人的几条按提交的先后），轮钟「该派给谁」按这个顺序算。
//
// 锁：先把这几位客人的来访、账单都锁上（id 升序，与前台的「来访 → 账单」同一个顺序），再逐条挂账；
// 每条里的技师队列、钟单、技师状态照旧在账单之后，不会出现「拿着技师队列再去锁另一位客人的来访」的反向加锁。
//
// 操作编号：整批一个编号，记成挂账（bill_post，查回、确认作废都与单张派钟相同，查回给第一位客人的来访）；
// 每一条另用由整批编号推出来的编号记在明细上（post_key）与操作编号表里，原样重提时整批编号先认出来，不会重复挂账。

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Deps, OpContext } from '../lib/context';
import { AppError, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { hashRequest, lockVisits, runIdempotent, saveKey } from './frontdesk/common';
import { clockroomBoard, DispatchInput } from './clockroom';

export const MAX_BATCH_DISPATCH = 10;

const Entry = DispatchInput.omit({ clientKey: true });

export const DispatchBatchInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  entries: z.array(Entry).min(1, '请至少派一条').max(MAX_BATCH_DISPATCH, `一次最多派 ${MAX_BATCH_DISPATCH} 条`),
});

/** 整批编号推出来的第 i 条的编号（UUID 格式，固定：同一个整批编号重提时还是这几个） */
export function entryKey(clientKey: string, index: number): string {
  const h = createHash('sha256').update(`dispatch-batch:${clientKey}:${index}`).digest('hex');
  // 写成 v4 / RFC 4122 变体的样子，能放进 uuid 列
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function dispatchBatch(deps: Deps, raw: unknown, ctx: OpContext) {
  const input = parse(DispatchBatchInput, raw);
  // 同一张预约在一批里出现两次：直接拒绝（第二条会撞上「已派过」，整批回滚，提示写清楚）
  const bookings = input.entries.flatMap((e) => (e.bookingId === undefined ? [] : [e.bookingId]));
  if (new Set(bookings).size !== bookings.length) throw unprocessable('BATCH_BOOKING_TWICE', '同一张预约在这一批里出现了两次，请去掉一条');
  // 固定顺序：来访编号从小到大，同一位客人的按提交的先后
  const ordered = input.entries.map((e, i) => ({ e, i })).sort((a, b) => a.e.visitId - b.e.visitId || a.i - b.i);
  const requestHash = hashRequest({ op: 'dispatch_batch', entries: input.entries });
  const { postChargesTx, PostInput } = await import('./frontdesk/bills');
  const base = (ctx.at ?? new Date()).getTime();
  await runIdempotent(deps, { key: input.clientKey, opType: 'bill_post', requestHash }, async (tx) => {
    const visitIds = [...new Set(ordered.map((x) => x.e.visitId))].sort((a, b) => a - b);
    const visits = await lockVisits(tx, visitIds);
    const billIds = [...visits.values()].map((v) => Number(v.billId)).sort((a, b) => a - b);
    await tx`SELECT id FROM bills WHERE id IN ${tx(billIds)} ORDER BY id FOR UPDATE`;
    const tags = new Map(
      (await tx<{ id: number; code: string }[]>`SELECT v.id, t.code FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE v.id IN ${tx(visitIds)}`).map((r) => [Number(r.id), r.code]),
    );
    for (const [n, { e, i }] of ordered.entries()) {
      const key = entryKey(input.clientKey, i);
      const post = parse(PostInput, {
        clientKey: key,
        lines: [{ itemId: e.itemId, quantity: e.quantity, tier: e.tier, technicianId: e.technicianId, callType: e.callType }],
        expectedTotal: e.expectedTotal,
      });
      const { clientKey: _k, ...payload } = post;
      const entryHash = hashRequest({ visitId: e.visitId, ...payload, batch: input.clientKey });
      // 每条错开 1 毫秒：派了轮钟的排到队尾时按这一批的先后排，不按技师编号
      const at = new Date(base + n);
      try {
        await postChargesTx(
          tx,
          deps,
          e.visitId,
          post,
          { key, requestHash: entryHash, backfill: null },
          { ...ctx, at },
          {
            session: { dispatch: { startNow: e.startNow, skipReason: e.skipReason, spaceId: e.spaceId, bookingId: e.bookingId } },
          },
        );
      } catch (error) {
        // 哪一条没过写在提示前面（整批都没有生效）；entry 是提交上来的第几条（从 0 数），页面按它标出那一行
        if (error instanceof AppError) throw new AppError(error.status, error.code, `手牌 ${tags.get(e.visitId) ?? ''}：${error.message}（这一批都没有派）`, { ...error.details, entry: i });
        throw error;
      }
    }
    await saveKey(tx, input.clientKey, 'bill_post', requestHash, visitIds[0]!, ctx.actor.id);
    return visitIds[0]!;
  });
  return clockroomBoard(deps.sql, deps);
}
