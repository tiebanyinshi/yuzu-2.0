// 技师榜单第一批（docs/TECH_RANKING.md，TR1–TR7）：名册 + 钟房状态的只读接口——三种状态与钟房一致（含休息、待上钟、停牌的细分），
// 服务中的项目、开始时间、时长、已服务与剩余秒数；不带客人信息；工种标签来自名册的工种字典；人气值 = 近 30 天点钟钟数；
// 权限（维护名册、钟房、上钟轮播任一项）；照片的上传、去重、去掉、按文件头认、审计与取图。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TechnicianRankingView } from '../src/shared/technician-ranking';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let backoffice: string;
let foot = 0;
const tech: Record<string, number> = {};

const ranking = async (cookie = ctx.clerk) => api<TechnicianRankingView>(ctx.app, cookie, 'GET', '/api/technician-ranking');
const KEYED = ['leave', 'suspend', 'resume'];
const state = (no: string, action: string, reason?: string) =>
  api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech[no]}/state`, {
    action,
    ...(reason ? { reason } : {}),
    ...(KEYED.includes(action) ? { clientKey: randomUUID() } : {}),
  });
let tagNo = 0;
const checkin = async () => {
  tagNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: `R${String(tagNo).padStart(3, '0')}`, zone: 'female' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const dispatch = async (no: string, opts: { startNow: boolean; callType: 'designated' | 'rotation' }) => {
  const d = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', {
    clientKey: randomUUID(),
    quantity: 1,
    startNow: opts.startNow,
    itemId: foot,
    expectedTotal: 12800,
    callType: opts.callType,
    ...(opts.callType === 'rotation' ? { skipReason: '合成跳过' } : {}),
    visitId: await checkin(),
    technicianId: tech[no],
  });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  const s = (d.body.sessions as { id: number; technicianId: number }[]).find((x) => x.technicianId === tech[no])!;
  return s.id;
};

// 最小的有效 PNG（1×1）；另一张换了一个字节的内容（仍以 PNG 文件头开头）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG2 = Buffer.concat([PNG, Buffer.from([0])]);
const photo = (no: string, body: unknown, cookie = ctx.owner) => api<{ photoUrl: string | null; photoVersion: number }>(ctx.app, cookie, 'PUT', `/api/admin/technicians/${tech[no]}/photo`, body);
const png = (buf: Buffer, version: number) => ({ mime: 'image/png', data: buf.toString('base64'), version });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'trhq', displayName: '后勤', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  backoffice = await login(ctx.app, 'trhq');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 20, width: 3, zone: 'female' })).status).toBe(200);
  const item = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '足疗', category: '足疗', durationMinutes: 60, technicianRequired: true, price: 12800 });
  foot = item.body.items.find((i: { name: string }) => i.name === '足疗').id;
  for (const [no, name, kind, nickname] of [
    ['31', '张小明', '足浴', '小明'],
    ['32', '李婷', '按摩', ''],
    ['33', '王芳', '足浴', ''],
    ['34', '赵敏', 'SPA', ''],
    ['35', '钱多', '按摩', ''],
    ['36', '孙丽', '采耳', ''],
    ['37', '周红', '足浴', ''],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name, gender: 'female', grade: 'standard', kind, nickname });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true, requireTechnician: false })).status).toBe(200);
  for (const no of ['31', '32', '33', '35', '37']) expect((await state(no, 'sign_in')).status).toBe(200);
  // 37 先做一个点钟、下钟（人气值 1），再做一个轮钟、下钟（不算人气）
  for (const callType of ['designated', 'rotation'] as const) {
    const id = await dispatch('37', { startNow: true, callType });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${id}/finish`)).status).toBe(200);
  }
  // 32 做一个轮钟，加 2 钟（默认「加钟算点钟」：加的 2 钟记成点钟，人气值 2），下钟
  const ext = await dispatch('32', { startNow: true, callType: 'rotation' });
  const e = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${ext}/extend`, { clientKey: randomUUID(), quantity: 2, expectedTotal: 25600 });
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${ext}/finish`)).status).toBe(200);
  await dispatch('31', { startNow: true, callType: 'designated' }); // 在钟上
  await dispatch('35', { startNow: false, callType: 'rotation' }); // 已派待上
  expect((await state('33', 'rest')).status).toBe(200); // 休息
  expect((await state('36', 'suspend', '合成停牌')).status).toBe(200); // 没上牌、停牌
  // 停用一位：不在榜单上
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: '38', name: '离职的', gender: 'female', grade: 'standard' });
  const gone = r.body.technicians.find((t: { techNo: string }) => t.techNo === '38').id;
  expect(
    (await api(ctx.app, ctx.owner, 'PUT', `/api/admin/technicians/${gone}`, { name: '离职的', gender: 'female', grade: 'standard', skills: [], active: false, sortOrder: 0, note: '' })).status,
  ).toBe(200);
});
afterAll(async () => ctx.close());

describe('技师榜单接口（第一批）', () => {
  it('三种状态与钟房一致，细分写在小字里；离职的不列；状态人数', async () => {
    const r = await ranking();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const by = new Map(r.body.techs.map((t) => [t.techNo, t]));
    expect([...by.keys()].sort()).toEqual(['31', '32', '33', '34', '35', '36', '37']);
    expect(by.get('31')).toMatchObject({ status: 'serving', note: null, name: '小明', realName: '张小明', kind: '足浴', photoUrl: null });
    expect(by.get('32')).toMatchObject({ status: 'idle', note: null });
    expect(by.get('33')).toMatchObject({ status: 'idle', note: 'rest' });
    expect(by.get('34')).toMatchObject({ status: 'off', note: null });
    expect(by.get('35')).toMatchObject({ status: 'serving', note: 'waiting' });
    expect(by.get('36')).toMatchObject({ status: 'off', note: 'suspended' });
    expect(by.get('37')).toMatchObject({ status: 'idle', note: null });
    expect(r.body.counts).toEqual({ idle: 3, serving: 2, off: 2 });
    expect(r.body).toMatchObject({ refreshSeconds: 30, pageSize: 12, popularityDays: 30 });
    // 与钟房同一份：钟房里的状态逐个对得上
    const clock = (await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom')).body as { technicians: { techNo: string; busy: { status: string } | null; state: string }[] };
    for (const t of clock.technicians) {
      const mine = by.get(t.techNo)!;
      if (t.busy) expect(mine.status).toBe('serving');
      else if (t.state === 'on' || t.state === 'rest') expect(mine.status).toBe('idle');
      else expect(mine.status).toBe('off');
    }
    // 综合榜：名次 1 起连续，在岗排位的在前
    expect(r.body.techs.map((t) => t.overallRank)).toEqual(r.body.techs.map((_, i) => i + 1));
  });

  it('服务中：项目、开始时间、时长、已服务与剩余；待上钟没有倒计时；不带客人、手牌、房间', async () => {
    let r = await ranking();
    const s = r.body.techs.find((t) => t.techNo === '31')!.service!;
    expect(s).toMatchObject({ itemName: '足疗', phase: 'serving', minutes: 60 });
    expect(new Date(s.plannedEnd!).getTime() - new Date(s.startedAt!).getTime()).toBe(60 * 60_000);
    expect(s.elapsedSeconds! + s.remainingSeconds!).toBeGreaterThanOrEqual(3600);
    expect(s.elapsedSeconds! + s.remainingSeconds!).toBeLessThanOrEqual(3601);
    // 把上钟时刻往前挪 20 分钟：已服务约 1200 秒，剩余约 2400 秒；挪到 70 分钟前：剩余 0（到点没下钟）
    await ctx.sql`UPDATE technician_sessions SET started_at = started_at - interval '20 minutes' WHERE id = ${s.sessionId}`;
    r = await ranking();
    const s2 = r.body.techs.find((t) => t.techNo === '31')!.service!;
    expect(Math.abs(s2.elapsedSeconds! - 1200)).toBeLessThanOrEqual(3);
    expect(Math.abs(s2.remainingSeconds! - 2400)).toBeLessThanOrEqual(3);
    await ctx.sql`UPDATE technician_sessions SET started_at = started_at - interval '50 minutes' WHERE id = ${s.sessionId}`;
    r = await ranking();
    expect(r.body.techs.find((t) => t.techNo === '31')!.service!.remainingSeconds).toBe(0);
    const w = r.body.techs.find((t) => t.techNo === '35')!.service!;
    expect(w).toMatchObject({ phase: 'waiting', startedAt: null, plannedEnd: null, elapsedSeconds: null, remainingSeconds: null, itemName: '足疗' });
    expect(r.body.techs.filter((t) => t.status !== 'serving').every((t) => t.service === null)).toBe(true);
    const json = JSON.stringify(r.body);
    expect(json).not.toMatch(/R0\d\d/); // 手牌
    expect(json).not.toContain('散客');
    expect(json).not.toContain('guest');
  });

  it('工种标签来自名册的工种字典（字典的顺序），名册里用着、字典里删掉的接在后面', async () => {
    let r = await ranking();
    expect(r.body.kinds).toEqual(['足浴', '按摩', 'SPA', '采耳', '其他']);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/technician-admin/kinds', { kinds: ['按摩', '足浴', 'SPA', '其他'] })).status).toBe(200);
    r = await ranking();
    expect(r.body.kinds).toEqual(['按摩', '足浴', 'SPA', '其他', '采耳']);
  });

  it('人气值：近 30 天已下钟的点钟钟数（按明细，轮钟上加的点钟也算）；轮钟、没下钟的不算；超过 30 天的不算', async () => {
    let r = await ranking();
    const pop = (no: string) => r.body.techs.find((t) => t.techNo === no)!.popularity;
    expect(pop('37')).toBe(1);
    expect(pop('31')).toBe(0); // 点钟还没下钟
    expect(pop('32')).toBe(2); // 轮钟不算，轮钟上加的 2 钟算点钟
    expect(pop('33')).toBe(0);
    await ctx.sql`UPDATE technician_sessions SET business_date = business_date - 30 WHERE technician_id = ${tech['37']!} AND status = 'done'`;
    r = await ranking();
    expect(pop('37')).toBe(0);
    await ctx.sql`UPDATE technician_sessions SET business_date = business_date + 1 WHERE technician_id = ${tech['37']!} AND status = 'done'`;
    r = await ranking();
    expect(pop('37')).toBe(1); // 第 29 天前（含今天共 30 天）还算
  });

  it('刷新间隔：技师规则里改（10–300 秒，默认 30），榜单接口跟着给', async () => {
    expect((await ranking()).body.refreshSeconds).toBe(30);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { rankingRefreshSeconds: 5 })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { rankingRefreshSeconds: 301 })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { rankingRefreshSeconds: 12.5 })).status).toBe(400);
    const ok = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { rankingRefreshSeconds: 60 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.rules).toMatchObject({ enabled: true, rankingRefreshSeconds: 60 });
    expect((await ranking()).body.refreshSeconds).toBe(60);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/technicians/rules', { rankingRefreshSeconds: 10 })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { rankingRefreshSeconds: 30 })).status).toBe(200);
  });

  it('权限：维护名册、钟房能看；都没有的不行；没登录 401', async () => {
    expect((await ranking(ctx.owner)).status).toBe(200);
    expect((await ranking(backoffice)).status).toBe(403);
    expect((await api(ctx.app, null, 'GET', '/api/technician-ranking')).status).toBe(401);
  });

  it('照片：上传、同一张不重存、换、去掉；按文件头认；要维护名册权限；审计；取图带长期缓存，只给本店', async () => {
    expect((await photo('32', png(PNG, 0), ctx.clerk)).status).toBe(403);
    expect((await photo('32', { mime: 'image/jpeg', data: PNG.toString('base64'), version: 0 })).body).toMatchObject({ error: { code: 'IMAGE_INVALID' } });
    expect((await photo('32', { mime: 'image/png', data: Buffer.from('not an image at all, just text').toString('base64'), version: 0 })).status).toBe(422);
    expect((await photo('32', { ...png(PNG, 0), extra: 1 })).status).toBe(400);
    expect((await photo('32', { mime: 'image/png', data: PNG.toString('base64') })).status).toBe(400); // 没带版本号
    const a = await photo('32', png(PNG, 0));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ photoVersion: 1 });
    expect(a.body.photoUrl).toMatch(/^\/api\/technician-photos\/\d+$/);
    const b = await photo('33', png(PNG, 0)); // 同一张图给另一位：只存一份
    expect(b.body.photoUrl).toBe(a.body.photoUrl);
    expect((await ctx.sql`SELECT count(*)::int AS n FROM technician_photos`)[0]!.n).toBe(1);
    let r = await ranking();
    expect(r.body.techs.find((t) => t.techNo === '32')!.photoUrl).toBe(a.body.photoUrl);
    const img = await ctx.app.inject({ method: 'GET', url: a.body.photoUrl!, headers: { cookie: ctx.clerk } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toContain('immutable');
    expect(img.rawPayload.equals(PNG)).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: a.body.photoUrl!, headers: { cookie: backoffice } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/technician-photos/999999', headers: { cookie: ctx.clerk } })).statusCode).toBe(404);
    // 没收到结果的原样重提（版本 0、同一张）：返回现在的，不再记审计
    expect((await photo('32', png(PNG, 0))).body).toEqual(a.body);
    // 换一张（版本 1 → 2）；之后迟到的「版本 0 传第一张」、「版本 1 去掉」都被拒绝，不覆盖
    const c = await photo('32', png(PNG2, 1));
    expect(c.body).toMatchObject({ photoVersion: 2 });
    expect(c.body.photoUrl).not.toBe(a.body.photoUrl);
    expect((await photo('32', png(PNG, 0))).body).toMatchObject({ error: { code: 'PHOTO_CHANGED' } });
    expect((await photo('32', { remove: true, version: 0 })).body).toMatchObject({ error: { code: 'PHOTO_CHANGED' } });
    expect((await photo('32', png(PNG2, 2))).body).toEqual(c.body); // 与现在的一样：不算改动
    const d = await photo('32', { remove: true, version: 2 });
    expect(d.body).toEqual({ photoUrl: null, photoVersion: 3 });
    expect((await photo('32', { remove: true, version: 2 })).body).toEqual(d.body); // 去掉的重提
    expect((await photo('32', png(PNG2, 1))).body).toMatchObject({ error: { code: 'PHOTO_CHANGED' } }); // 换照片的迟到重提不会把去掉的改回来
    r = await ranking();
    expect(r.body.techs.find((t) => t.techNo === '32')!.photoUrl).toBeNull();
    // 技师管理的名册带着照片地址与版本号（新打开的页面按它提交）
    const roster = (await api(ctx.app, ctx.owner, 'GET', '/api/technician-admin')).body.technicians as { techNo: string; photoUrl: string | null; photoVersion: number }[];
    expect(roster.find((t) => t.techNo === '32')).toMatchObject({ photoUrl: null, photoVersion: 3 });
    expect(roster.find((t) => t.techNo === '33')).toMatchObject({ photoUrl: a.body.photoUrl, photoVersion: 1 });
    expect(roster.find((t) => t.techNo === '34')).toMatchObject({ photoUrl: null, photoVersion: 0 });
    const audit = await ctx.sql<{ detail: { summary: string } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'technician_saved' AND target_id = ${tech['32']!} AND detail->>'summary' LIKE '%照片%' ORDER BY id`;
    expect(audit.map((x) => x.detail.summary)).toEqual(['上传技师照片 32 李婷', '更换技师照片 32 李婷', '去掉技师照片 32 李婷']);
    // 照片只追加
    const deleted = await ctx.sql`DELETE FROM technician_photos`.then(
      () => 'deleted',
      () => 'refused',
    );
    expect(deleted).toBe('refused');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/999999/photo', png(PNG, 0))).status).toBe(404);
  });
});
