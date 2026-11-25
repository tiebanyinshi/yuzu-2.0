// 回测整改 P09（回测 4-2，docs/YUZU_REQ_V820.md 第 10 节）：技师上钟轮播的数据——排钟顺序、在钟的项目与房间、房间所在区域、
// 下一位排钟；不列休息以外不在岗的；只读，「技师上钟轮播」「钟房」「上钟播报」任一项都能看，都没有的不行；新权限进了有「上钟播报」的岗位的建议权限。
// 全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TechBoardView } from '../src/shared/tech-board';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let backoffice: string;
let foot = 0;
let roomId = 0;
const tech: Record<string, number> = {};

const ZONES_CSV = ['楼层,区域名(中文),区域名(英文),备注', 'L3,合成足浴区,Sample Foot,合成样例'].join('\r\n');
const SPACES_CSV = ['楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注', 'L3,F,F312,足浴,4,合成足浴间,,合成 F312,'].join('\r\n');
const board = async (cookie = ctx.clerk) => api<TechBoardView>(ctx.app, cookie, 'GET', '/api/tech-board');
const state = (no: string, action: string) => api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech[no]}/state`, { action });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'tbhq', displayName: '后勤', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  backoffice = await login(ctx.app, 'tbhq');
  for (const [kind, csv] of [
    ['zones', ZONES_CSV],
    ['spaces', SPACES_CSV],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv, encoding: 'UTF-8', clientKey: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  roomId = ((await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body.spaces as { id: number; code: string }[]).find((s) => s.code === 'F312')!.id;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'B', from: 1, to: 10, width: 3, zone: 'female' })).status).toBe(200);
  const item = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '足疗', category: '足疗', durationMinutes: 60, technicianRequired: true, price: 12800 });
  foot = item.body.items.find((i: { name: string }) => i.name === '足疗').id;
  for (const [no, name] of [
    ['21', '张小明'],
    ['22', '李婷'],
    ['23', '王芳'],
    ['24', '赵敏'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name, gender: 'female', grade: 'standard' });
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true, requireTechnician: false })).status).toBe(200);
  for (const no of ['21', '22', '23']) expect((await state(no, 'sign_in')).status).toBe(200);
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'B001', zone: 'female' }] });
  const d = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', {
    clientKey: randomUUID(),
    quantity: 1,
    startNow: true,
    itemId: foot,
    expectedTotal: 12800,
    callType: 'rotation',
    visitId: v.body.visits[0].id,
    technicianId: tech['21'],
    spaceId: roomId,
  });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
});
afterAll(async () => ctx.close());

describe('技师上钟轮播（P09）', () => {
  it('排钟顺序、在钟的项目、房间与区域、下一位；没上牌的不列；不带客人信息', async () => {
    const r = await board();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body;
    expect(b.techs.map((t) => t.techNo)).not.toContain('24');
    const serving = b.techs.find((t) => t.techNo === '21')!;
    expect(serving.status).toBe('serving');
    expect(b.techs.filter((t) => t.status === 'idle').map((t) => t.techNo)).toEqual(['22', '23']);
    // 队列里的按位置排在前面
    const positions = b.techs.filter((t) => t.position !== null).map((t) => t.position!);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(b.next).toEqual({ techNo: '22', name: '李婷' });
    expect(b.sessions).toHaveLength(1);
    expect(b.sessions[0]).toMatchObject({ technicianId: tech['21'], itemName: '足疗', status: 'serving', room: 'F312', area: '三层', minutes: 60, clocks: 1 });
    expect(b.items).toEqual(['足疗']);
    expect(b.areas).toEqual(['三层']); // 空间没挂区域的写楼层
    expect(JSON.stringify(b)).not.toContain('B001');
  });

  it('只读：钟房的岗位能看；都没有的看不到；新权限进了有「上钟播报」的岗位的建议权限', async () => {
    expect((await board(backoffice)).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/tech-board', {})).status).toBe(404);
    const rows = await ctx.sql<{ positionKey: string }[]>`
      SELECT a.position_key FROM position_suggestions a
      WHERE a.permission = 'technician.announce'
        AND NOT EXISTS (SELECT 1 FROM position_suggestions b WHERE b.position_key = a.position_key AND b.permission = 'technician.board')`;
    expect(rows).toEqual([]);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM position_suggestions WHERE permission = 'technician.board'`;
    expect(n!.n).toBeGreaterThan(0);
  });
});
