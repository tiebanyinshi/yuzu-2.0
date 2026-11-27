// 8.2.7 收银台「锁牌外出」（docs/V8227_AWAY_LOCK.md）：
//   · 锁之前先收预售（一张手牌押金「锁牌外出预收」），没收到不锁；最多 4 小时；
//   · 锁着期间不能挂账，预售不能单独退；客人回来解锁（取消外出）；结账时自动解锁、预售照押金抵扣；
//   · 到时间自动解锁、推给值班经理；锁、解锁带操作编号（重提只锁一次、确认作废）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { awayLockPrefill } from '../src/shared/away-lock';
import type { CheckoutPreview } from '../src/shared/checkout';
import type { VisitDetail } from '../src/shared/frontdesk';
import { sweepAwayLocks } from '../src/server/modules/frontdesk/away-lock';
import { api, balanceOf, createMember, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;
let itemId = 0;

const enter = async (extra: Record<string, unknown> = {}) => {
  tagNo += 1;
  const tagCode = `L${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', ...extra }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0] as { id: number; tagCode: string };
};
const post = (visitId: number) =>
  api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines: [{ itemId, quantity: 1 }], expectedTotal: 8800 });
const lock = (visitId: number, body: Record<string, unknown>, key = randomUUID()) =>
  api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/away-lock`, { clientKey: key, minutes: 120, deposit: { amount: 20000, method: 'cash' }, ...body });
const unlock = (visitId: number, key = randomUUID()) => api<VisitDetail>(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/away-unlock`, { clientKey: key });
const code = (r: { body: unknown }) => (r.body as { error?: { code: string } }).error?.code;
const checks = async () => {
  const fd = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; label: string; detail: string }[];
  for (const c of fd) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'L', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
  const a = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '柠檬茶', category: '饮品', price: 8800 });
  itemId = a.body.items.find((i: { name: string }) => i.name === '柠檬茶').id;
  expect((await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 })).status).toBe(200);
});
afterAll(async () => {
  await ctx?.close();
});

describe('锁牌外出', () => {
  it('预售预填：此刻应收减去已押的押金，至少是默认押金', () => {
    expect(awayLockPrefill({ billCents: 8800, discountCents: 0, ticketCents: 9900, heldDepositCents: 0, minimumCents: 10000 })).toBe(18700);
    expect(awayLockPrefill({ billCents: 0, discountCents: 0, ticketCents: 0, heldDepositCents: 0, minimumCents: 10000 })).toBe(10000);
    expect(awayLockPrefill({ billCents: 30000, discountCents: 5000, ticketCents: 0, heldDepositCents: 20000, minimumCents: 10000 })).toBe(10000);
  });

  it('先收预售再锁：最多 4 小时；没填预售不锁；锁着不能挂账、预售不能单独退；回来解锁取消外出；同一编号只锁一次', async () => {
    const v = await enter();
    expect((await post(v.id)).status).toBe(200);
    // 超过 4 小时、没填预售的都拒绝，什么都不记
    expect((await lock(v.id, { minutes: 241 })).status).toBe(400);
    expect((await lock(v.id, { deposit: { amount: 0, method: 'cash' } })).status).toBe(400);
    expect((await ctx.sql`SELECT 1 FROM tag_deposits WHERE visit_id = ${v.id}`).length).toBe(0);

    const key = randomUUID();
    const r = await lock(v.id, {}, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.awayLock).toMatchObject({ reason: '锁牌外出预收', deposit: { amount: 20000, method: 'cash' } });
    expect(Date.parse(r.body.awayLock!.lockUntil) - Date.parse(r.body.awayLock!.lockedAt)).toBe(120 * 60_000);
    expect(r.body.awaySince).not.toBeNull();
    expect(r.body.deposits!.filter((d) => d.status === 'held').map((d) => [d.reason, d.amount])).toEqual([['锁牌外出预收', 20000]]);
    // 原样重提：只锁一次、只收一笔
    expect((await lock(v.id, {}, key)).status).toBe(200);
    expect((await ctx.sql`SELECT count(*)::int AS n FROM tag_deposits WHERE visit_id = ${v.id}`)[0]!.n).toBe(1);
    // 已经锁着的不能再锁
    expect(code(await lock(v.id, {}))).toBe('TAG_AWAY_LOCKED');
    // 手牌板上标着锁到几点
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body as { tags: { code: string; visit: { awayLockUntil: string | null } | null }[] };
    expect(board.tags.find((t) => t.code === v.tagCode)!.visit!.awayLockUntil).toBe(r.body.awayLock!.lockUntil);
    // 锁着：不能挂账；预售不能单独退
    expect(code(await post(v.id))).toBe('TAG_AWAY_LOCKED');
    const depositId = r.body.awayLock!.deposit.id;
    expect(code(await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/deposits/${depositId}/refund`, { clientKey: randomUUID() }))).toBe('DEPOSIT_LOCKING');

    // 客人回来解锁：外出取消、能挂账；预售照押金留着
    const back = await unlock(v.id);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.awayLock).toBeNull();
    expect(back.body.awaySince).toBeNull();
    expect(code(await unlock(v.id))).toBe('NOT_AWAY_LOCKED');
    expect((await post(v.id)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/deposits/${depositId}/refund`, { clientKey: randomUUID() })).status).toBe(200);
    const [row] = await ctx.sql<{ releaseKind: string }[]>`SELECT release_kind FROM visit_tag_locks WHERE visit_id = ${v.id}`;
    expect(row!.releaseKind).toBe('return');
    await checks();
  });

  it('转单也不能转进锁着的牌；前台「返回」一并解锁', async () => {
    const a = await enter();
    const b = await enter();
    const line = (await post(a.id)).body.lines.find((l) => l.status === 'active')!;
    expect((await lock(b.id, {})).status).toBe(200);
    const moved = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/lines/move', { clientKey: randomUUID(), lineIds: [line.id], toTagCode: b.tagCode, reason: '挂错手牌' });
    expect(code(moved)).toBe('TAG_AWAY_LOCKED');
    // 前台异常处置点「返回」：外出取消，锁一并解开（不留「已返回、牌还锁着」）
    const back = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${b.id}/incidents`, { clientKey: randomUUID(), kind: 'return' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const [row] = await ctx.sql<{ releaseKind: string; releasedBy: number }[]>`SELECT release_kind, released_by FROM visit_tag_locks WHERE visit_id = ${b.id}`;
    expect(row!.releaseKind).toBe('return');
    expect(row!.releasedBy).not.toBeNull();
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/lines/move', { clientKey: randomUUID(), lineIds: [line.id], toTagCode: b.tagCode, reason: '挂错手牌' });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    await checks();
  });

  it('锁着也不能入住客房、不能开派对房等的使用单（这几处不走挂账，单独核对）', async () => {
    const v = await enter();
    expect((await lock(v.id, {})).status).toBe(200);
    // 客房
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '锁牌用例房', kind: 'daily', price: 38800 });
    const typeId = t.body.types.find((x: { name: string }) => x.name === '锁牌用例房').id;
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo: '901', floor: '9', roomTypeId: typeId });
    const roomId = r.body.rooms.find((x: { roomNo: string }) => x.roomNo === '901').id;
    const stay = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', { clientKey: randomUUID(), guests: 1, roomId, expectedRate: 38800, tagCode: v.tagCode });
    expect(code(stay), JSON.stringify(stay.body)).toBe('TAG_AWAY_LOCKED');
    // 派对房等的使用单
    expect(
      (
        await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', {
          kind: 'spaces',
          fileName: 's.csv',
          encoding: 'UTF-8',
          clientKey: randomUUID(),
          csv: ['楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注', 'L2,,X901,派对房,8,锁牌用例派对房,,,'].join('\r\n'),
        })
      ).status,
    ).toBe(201);
    const sp = ((await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body.spaces as { id: number; code: string }[]).find((x) => x.code === 'X901')!;
    const usage = await api(ctx.app, ctx.clerk, 'POST', '/api/usages', { clientKey: randomUUID(), spaceId: sp.id, tagCode: v.tagCode });
    expect(code(usage), JSON.stringify(usage.body)).toBe('TAG_AWAY_LOCKED');
    // 解锁以后都能用
    expect((await unlock(v.id)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/usages', { clientKey: randomUUID(), spaceId: sp.id, tagCode: v.tagCode })).status).toBe(200);
  });

  it('结账时自动解锁，预售照押金抵扣；储值收的预售先退回原卡再扣', async () => {
    const m = await createMember(ctx, '锁牌会员');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 100000, 0))).status).toBe(200);
    const v = await enter({ memberId: m.id });
    expect((await post(v.id)).status).toBe(200);
    const r = await lock(v.id, { deposit: { amount: 30000, method: 'wallet', expectedSplit: { principal: 30000, bonus: 0 } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await balanceOf(ctx, m.id)).principal).toBe(70000);
    const p = (await api<CheckoutPreview>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v.id}`)).body;
    expect(p.deposits!.map((d) => [d.method, d.amount])).toEqual([['wallet', 30000]]);
    const total = p.totalAmount;
    const done = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v.id],
      expectedTotal: total,
      payments: [{ method: 'wallet', memberId: m.id, amount: total, expectedSplit: { principal: total, bonus: 0 } }],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await balanceOf(ctx, m.id)).principal).toBe(100000 - total);
    const [row] = await ctx.sql<{ releaseKind: string }[]>`SELECT release_kind FROM visit_tag_locks WHERE visit_id = ${v.id}`;
    expect(row!.releaseKind).toBe('checkout');
    await checks();
  });

  it('到时间自动解锁（经办人「系统」）、推给值班经理；外出标记留着', async () => {
    const v = await enter();
    const r = await lock(v.id, { minutes: 30 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // 还没到时间：不动
    expect(await sweepAwayLocks({ sql: ctx.sql, config: ctx.config }, new Date(Date.now() + 10 * 60_000))).toBe(0);
    expect(await sweepAwayLocks({ sql: ctx.sql, config: ctx.config }, new Date(Date.now() + 31 * 60_000))).toBe(1);
    const after = (await api<VisitDetail>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v.id}`)).body;
    expect(after.awayLock).toBeNull();
    expect(after.awaySince).not.toBeNull();
    const [row] = await ctx.sql<{ releaseKind: string }[]>`SELECT release_kind FROM visit_tag_locks WHERE visit_id = ${v.id}`;
    expect(row!.releaseKind).toBe('expired');
    const notes = await ctx.sql<{ title: string }[]>`SELECT title FROM oa_notifications WHERE ref_type = 'visit_tag_lock'`;
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]!.title).toContain(v.tagCode);
    // 再扫一次不重复
    expect(await sweepAwayLocks({ sql: ctx.sql, config: ctx.config }, new Date(Date.now() + 40 * 60_000))).toBe(0);
    // 锁牌记录只追加
    await expect(ctx.sql`UPDATE visit_tag_locks SET reason = '改' WHERE visit_id = ${v.id}`).rejects.toThrow();
    // 一笔锁最长 4 小时（数据库也兜底）
    await expect(ctx.sql`UPDATE visit_tag_locks SET lock_until = locked_at + interval '5 hours' WHERE visit_id = ${v.id}`).rejects.toThrow();
  });

  it('确认作废过的锁牌编号：原请求再到整笔回滚，不收预售', async () => {
    const v = await enter();
    const key = randomUUID();
    const ab = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${key}/abandon`, { type: 'tag_away_lock' });
    expect(ab.status, JSON.stringify(ab.body)).toBe(200);
    expect(code(await lock(v.id, {}, key))).toBe('OP_ABANDONED');
    expect((await ctx.sql`SELECT 1 FROM tag_deposits WHERE visit_id = ${v.id}`).length).toBe(0);
    // 查回：锁成功的编号能查到这位客人
    const ok = randomUUID();
    expect((await lock(v.id, {}, ok)).status).toBe(200);
    const found = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${ok}?type=tag_away_lock`);
    expect(found.body).toMatchObject({ found: true, type: 'tag_away_lock', visit: { id: v.id } });
  });
});
