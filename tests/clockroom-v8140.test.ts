// 8.1.40（B）钟房：排位调到某人前面、一次给多张手牌派钟（docs/V8140_B.md）。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { entryKey } from '../src/server/modules/clockroom-batch';
import { moveBeforeKeys } from '../src/server/modules/clockroom-queue';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let foot: number; // 足疗 198 / 238 / 298、90 分钟
let gua: number; // 刮痧 128
let tagNo = 0;
const tech: Record<string, number> = {};

const board = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom')).body;
const queue = async (kind?: string) =>
  ((await board()).technicians as { techNo: string; kind: string; position: number | null }[])
    .filter((t) => t.position !== null && (kind === undefined || t.kind === kind))
    .sort((a, b) => a.position! - b.position!)
    .map((t) => t.techNo);
const state = (techNo: string, action: string, reason?: string) => api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech[techNo]}/state`, { action, ...(reason ? { reason } : {}) });
const move = (techNo: string, before: string, reason = '客人等着，先叫他', cookie = ctx.clerk, clientKey: string = randomUUID()) =>
  api(ctx.app, cookie, 'POST', `/api/clockroom/technicians/${tech[techNo]}/move-before`, { clientKey, beforeId: tech[before], reason });
const enter = async () => {
  tagNo += 1;
  const code = `B${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'female' }] });
  expect(r.status).toBe(201);
  return { id: r.body.visits[0].id as number, code };
};
const events = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events')).body as { kind: string; techNo: string | null; text: string }[];
const saveKind = async (no: string, kind: string) => {
  const me = ((await board()).technicians as { techNo: string; gender: string; grade: string }[]).find((t) => t.techNo === no)!;
  const r = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/technicians/${tech[no]}`, {
    name: `技师${no}`,
    gender: me.gender,
    grade: me.grade,
    skills: [],
    note: '',
    active: true,
    sortOrder: 0,
    kind,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
/** 把在岗的几位按给的顺序排好（依次排到队尾） */
const lineUp = async (nos: string[]) => {
  for (const no of nos) expect((await state(no, 'to_end', '排回用例的顺序')).status).toBe(200);
};
const sessionsOf = async (visitId: number) => ((await board()).sessions as { visitId: number; techNo: string; status: string }[]).filter((s) => s.visitId === visitId);

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'back', displayName: '后勤', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'B', from: 1, to: 60, width: 3, zone: 'female' })).status).toBe(200);
  const add = async (body: Record<string, unknown>) => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { technicianRequired: true, ...body });
    expect(r.status).toBe(200);
    return r.body.items.find((i: { name: string }) => i.name === body.name).id as number;
  };
  foot = await add({ name: '足疗', category: '足疗', durationMinutes: 90, prices: { standard: 19800, professional: 23800, premium: 29800 } });
  gua = await add({ name: '刮痧', category: '理疗', price: 12800 });
  for (const no of ['01', '02', '03', '04', '05']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name: `技师${no}`, gender: 'female', grade: 'standard' });
    expect(r.status).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/technician-admin/kinds', { kinds: ['足浴', '按摩', 'SPA', '中医', '采耳', '其他'] })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('排位调到某人前面', () => {
  it('算新的排位：只改要调的人；挤不下时往前依次提前 1 毫秒，被调到前面的那位和后面的不动', () => {
    // 有空隙：A(0) B(10) T(20) → 把 M 插到 T 前面
    expect([
      ...moveBeforeKeys(
        [1, 2, 9, 3],
        new Map([
          [1, 0],
          [2, 10],
          [9, 50],
          [3, 20],
        ]),
        9,
      ),
    ]).toEqual([[9, 19]]);
    // 同一时刻：A(20) M T(20)：M = 19，A 提前到 18
    expect([
      ...moveBeforeKeys(
        [1, 9, 3],
        new Map([
          [1, 20],
          [9, 50],
          [3, 20],
        ]),
        9,
      ),
    ]).toEqual([
      [9, 19],
      [1, 18],
    ]);
    // 连着挤：A(18) B(19) M T(20)：M = 19，B = 18，A = 17
    expect([
      ...moveBeforeKeys(
        [1, 2, 9, 3],
        new Map([
          [1, 18],
          [2, 19],
          [9, 50],
          [3, 20],
        ]),
        9,
      ),
    ]).toEqual([
      [9, 19],
      [2, 18],
      [1, 17],
    ]);
  });

  it('调到同工种在岗的人前面，原因必填，记日志；暂离、未上牌、不同工种、调到自己前面都拒绝；没有钟房权限的不行', async () => {
    for (const no of ['01', '02', '03', '04']) expect((await state(no, 'sign_in')).status).toBe(200);
    await lineUp(['01', '02', '03', '04']);
    expect(await queue()).toEqual(['01', '02', '03', '04']);
    // 原因必填
    const bad = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech['04']}/move-before`, { clientKey: randomUUID(), beforeId: tech['02'], reason: '叫' });
    expect(bad.body.error).toMatchObject({ code: 'REASON_REQUIRED' });
    const r = await move('04', '02');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await queue()).toEqual(['01', '04', '02', '03']);
    expect((await events()).find((e) => e.kind === 'queue')).toMatchObject({ techNo: '04', text: '调到 02 号前面：客人等着，先叫他' });
    // 往后调：01 调到 03 前面
    expect((await move('01', '03')).status).toBe(200);
    expect(await queue()).toEqual(['04', '02', '01', '03']);
    // 调到队首
    expect((await move('03', '04')).status).toBe(200);
    expect(await queue()).toEqual(['03', '04', '02', '01']);
    // 已经就在他前面：不变、不另记日志
    const n = (await events()).filter((e) => e.kind === 'queue').length;
    expect((await move('03', '04')).status).toBe(200);
    expect((await events()).filter((e) => e.kind === 'queue').length).toBe(n);
    expect(await queue()).toEqual(['03', '04', '02', '01']);

    expect((await move('03', '03')).body.error.code).toBe('MOVE_SELF');
    // 暂离的不在排位里
    await state('02', 'rest');
    expect((await move('02', '04')).body.error).toMatchObject({ code: 'NOT_ON' });
    expect((await move('04', '02')).body.error).toMatchObject({ code: 'TARGET_NOT_ON' });
    await state('02', 'back');
    // 未上牌
    expect((await move('05', '04')).body.error.code).toBe('NOT_ON');
    // 不同工种
    await saveKind('01', '中医');
    const cross = await move('01', '03');
    expect(cross.status).toBe(422);
    expect(cross.body.error).toMatchObject({ code: 'QUEUE_KIND_MISMATCH' });
    expect(cross.body.error.message).toContain('只能调到同工种的技师前面');
    await saveKind('01', '');
    // 没有钟房权限
    expect((await move('01', '03', '没有权限', await login(ctx.app, 'back'))).status).toBe(403);
  });

  it('同一时刻上牌的几位（排位相同）也能调开；调完以后轮钟按新的排位派', async () => {
    // 全部上牌：05 进来；把几位排成同一个 queue_key
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/sign-in-all')).status).toBe(200);
    await ctx.sql`UPDATE technician_status SET queue_key = '2026-01-01T00:00:00Z'`;
    expect(await queue()).toEqual(['01', '02', '03', '04', '05']);
    expect((await move('05', '02')).status).toBe(200);
    expect(await queue()).toEqual(['01', '05', '02', '03', '04']);
    expect((await move('04', '01')).status).toBe(200);
    expect(await queue()).toEqual(['04', '01', '05', '02', '03']);
    // 轮钟派给新的第一位不用写原因
    const v = await enter();
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', {
      clientKey: randomUUID(),
      visitId: v.id,
      itemId: gua,
      quantity: 1,
      technicianId: tech['04'],
      callType: 'rotation',
      startNow: true,
      expectedTotal: 12800,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe('一次给多张手牌派钟', () => {
  it('几张手牌一次派：按来访先后算轮钟，全部生效；同一个编号重提不重复挂账', async () => {
    // 先把上一条派的钟取消，排好队：01 02 03 05（04 回到原位以后排尾）
    const prev = (await board()).sessions as { id: number }[];
    for (const s of prev) expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${s.id}/void`, { reason: '用例取消' })).status).toBe(200);
    await lineUp(['01', '02', '03', '04', '05']);
    const a = await enter();
    const b = await enter();
    const clientKey = randomUUID();
    // 故意倒着提交：服务端按来访先后（a 在前）派，a 轮到 01、b 轮到 02
    const body = {
      clientKey,
      entries: [
        { visitId: b.id, itemId: gua, quantity: 1, technicianId: tech['02'], callType: 'rotation', startNow: true, expectedTotal: 12800 },
        { visitId: a.id, itemId: foot, quantity: 1, technicianId: tech['01'], callType: 'rotation', startNow: true, expectedTotal: 19800 },
      ],
    };
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch-batch', body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await sessionsOf(a.id)).map((s) => s.techNo)).toEqual(['01']);
    expect((await sessionsOf(b.id)).map((s) => s.techNo)).toEqual(['02']);
    // 派了轮钟的按这一批的先后排到队尾
    expect(await queue()).toEqual(['03', '04', '05', '01', '02']);
    // 每条的明细用推出来的编号
    const lines = await ctx.sql<{ postKey: string }[]>`SELECT post_key FROM bill_lines WHERE bill_id IN (SELECT bill_id FROM visits WHERE id IN ${ctx.sql([a.id, b.id])}) ORDER BY id`;
    expect(lines.map((l) => l.postKey)).toEqual([entryKey(clientKey, 1), entryKey(clientKey, 0)]);
    // 原样重提：返回成功，不重复挂账
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch-batch', body);
    expect(again.status).toBe(200);
    expect((await sessionsOf(a.id)).length + (await sessionsOf(b.id)).length).toBe(2);
    // 查回：记成挂账，给第一位客人的来访
    const found = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${clientKey}?type=bill_post`);
    expect(found.body).toMatchObject({ found: true, type: 'bill_post', visit: { id: a.id } });
    // 同一个编号换了内容：拒绝
    const changed = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch-batch', { ...body, entries: body.entries.slice(0, 1) });
    expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('有一条不行整批都不派（写明哪张手牌），轮钟跳过照样要原因；最多 10 条', async () => {
    // 队列 03 04 05（01 02 在钟上）
    const c = await enter();
    const d = await enter();
    const before = await queue();
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch-batch', {
      clientKey: randomUUID(),
      entries: [
        { visitId: c.id, itemId: gua, quantity: 1, technicianId: tech['03'], callType: 'rotation', startNow: true, expectedTotal: 12800 },
        // 轮钟该派 04，派 05 没写原因
        { visitId: d.id, itemId: gua, quantity: 1, technicianId: tech['05'], callType: 'rotation', startNow: true, expectedTotal: 12800 },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('SKIP_REASON_REQUIRED');
    expect(r.body.error.message).toContain(`手牌 ${d.code}：`);
    expect(r.body.error.details).toMatchObject({ entry: 1 });
    // 第一条也没有生效
    expect(await sessionsOf(c.id)).toEqual([]);
    expect(await queue()).toEqual(before);
    const bills = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bill_lines WHERE bill_id IN (SELECT bill_id FROM visits WHERE id IN ${ctx.sql([c.id, d.id])})`;
    expect(bills[0]!.n).toBe(0);
    // 价格变了也整批拒绝
    const price = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch-batch', {
      clientKey: randomUUID(),
      entries: [
        { visitId: c.id, itemId: gua, quantity: 1, technicianId: tech['03'], callType: 'rotation', startNow: true, expectedTotal: 12800 },
        { visitId: d.id, itemId: gua, quantity: 1, technicianId: tech['04'], callType: 'rotation', startNow: true, expectedTotal: 9900 },
      ],
    });
    expect(price.body.error.code).toBe('PRICE_CHANGED');
    expect(await sessionsOf(c.id)).toEqual([]);
    // 写了原因就能跳过；同一位技师在一批里派两次轮钟：第二次他已经在钟上
    const busy = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch-batch', {
      clientKey: randomUUID(),
      entries: [
        { visitId: c.id, itemId: gua, quantity: 1, technicianId: tech['03'], callType: 'rotation', startNow: true, expectedTotal: 12800 },
        { visitId: d.id, itemId: gua, quantity: 1, technicianId: tech['03'], callType: 'rotation', startNow: true, expectedTotal: 12800 },
      ],
    });
    expect(busy.body.error.code).toBe('TECHNICIAN_BUSY');
    const ok = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch-batch', {
      clientKey: randomUUID(),
      entries: [
        { visitId: c.id, itemId: gua, quantity: 1, technicianId: tech['03'], callType: 'rotation', startNow: true, expectedTotal: 12800 },
        { visitId: d.id, itemId: gua, quantity: 1, technicianId: tech['05'], callType: 'rotation', skipReason: '客人要 5 号的手法', startNow: true, expectedTotal: 12800 },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await events()).find((e) => e.kind === 'skip')).toMatchObject({ techNo: '04', text: '轮到时跳过，派给 05 号 技师05：客人要 5 号的手法' });
    // 最多 10 条
    const many = Array.from({ length: 11 }, () => ({ visitId: c.id, itemId: gua, quantity: 1, technicianId: tech['04'], callType: 'designated', startNow: false, expectedTotal: 12800 }));
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch-batch', { clientKey: randomUUID(), entries: many })).status).toBe(400);
  });

  it('确认作废的编号原请求迟到也不生效；没有前台挂账权限的不能批量派', async () => {
    const e = await enter();
    const clientKey = randomUUID();
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${clientKey}/abandon`, { type: 'bill_post' })).status).toBe(200);
    const late = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch-batch', {
      clientKey,
      entries: [{ visitId: e.id, itemId: gua, quantity: 1, technicianId: tech['04'], callType: 'designated', startNow: false, expectedTotal: 12800 }],
    });
    expect(late.status).toBe(409);
    expect(await sessionsOf(e.id)).toEqual([]);
    const back = await login(ctx.app, 'back');
    expect(
      (
        await api(ctx.app, back, 'POST', '/api/clockroom/dispatch-batch', {
          clientKey: randomUUID(),
          entries: [{ visitId: e.id, itemId: gua, quantity: 1, technicianId: tech['04'], callType: 'designated', startNow: false, expectedTotal: 12800 }],
        })
      ).status,
    ).toBe(403);
  });

  it('调排位带操作编号（合并前 Codex 审查 fca1ba4）：同一编号重提不再调一次；确认作废以后迟到的原请求不生效、之后另调的顺序不会被盖掉', async () => {
    for (const no of ['01', '02', '03', '04']) {
      const s0 = await state(no, 'sign_in');
      expect(s0.status).toBe(200);
    }
    await lineUp(['01', '02', '03', '04']);
    // 前面几条用例留下的别的技师（05……）可能还在岗：只看这四位的相对顺序
    const q4 = async () => (await queue()).filter((n) => ['01', '02', '03', '04'].includes(n));
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech['04']}/move-before`, { beforeId: tech['02'], reason: '没有编号' })).status).toBe(400);

    const key = randomUUID();
    expect((await move('04', '01', '客人等着，先叫他', ctx.clerk, key)).status).toBe(200);
    expect(await q4()).toEqual(['04', '01', '02', '03']);
    // 之后另调：01 调到 04 前面；原来那一笔原样重提不会把 04 再调回去
    expect((await move('01', '04')).status).toBe(200);
    expect(await q4()).toEqual(['01', '04', '02', '03']);
    expect((await move('04', '01', '客人等着，先叫他', ctx.clerk, key)).status).toBe(200);
    expect(await q4()).toEqual(['01', '04', '02', '03']);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=technician_state`)).body).toMatchObject({ found: true, technicianId: tech['04'] });

    // 没收到结果、确认作废：迟到的原请求拒绝，顺序不变
    const lost = randomUUID();
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${lost}/abandon`, { type: 'technician_state' })).status).toBe(200);
    const late = await move('03', '01', '迟到的那一笔', ctx.clerk, lost);
    expect(late.body.error?.code).toBe('OP_ABANDONED');
    expect(await q4()).toEqual(['01', '04', '02', '03']);
  });
});
