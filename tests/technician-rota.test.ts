// 8.1.41 轮班周期（docs/V8141_ROTA.md；店主《门店系统需求梳理与优化方案》2026-11-25「自定义轮班」）：
//   · 轮班清单整份保存：名字、口径（按周期轮转 / 每月 1 日固定转班）、起算日、各段；班次要在用；新建的编号接着排；审计；
//   · 按轮班生成排班：与排班同一条路——没变的跳过、今天已经排了的不能改、过去的拒绝、逐格留痕、一条审计写明是哪份轮班；
//     每位技师可以错开几段；每月 1 日固定转班的 31 日按最后一段；
//   · 权限：钟房的岗位能看，改清单、生成排班要「维护技师名册」。
// 全部是合成数据。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shiftDate } from '../src/shared/labels';
import type { ScheduleView, TechnicianAdminView } from '../src/shared/technician-admin';
import { rotaCellOn, type TechRota } from '../src/shared/technician-rota';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today = '';
let early = 0;
let late = 0;
let parked = 0;
const tech: Record<string, number> = {};

type Fail = { error: { code: string; message: string } };
type Applied = ScheduleView & { changed: number } & Fail;

const rotas = async (cookie = ctx.clerk) => (await api<{ rotas: TechRota[] }>(ctx.app, cookie, 'GET', '/api/technician-admin/rotas')).body.rotas;
const save = (list: Record<string, unknown>[], cookie = ctx.owner) => api<{ rotas: TechRota[] } & Fail>(ctx.app, cookie, 'PUT', '/api/technician-admin/rotas', { rotas: list });
const applyRota = (id: number, body: Record<string, unknown>, cookie = ctx.owner, from = today, days = 7) =>
  api<Applied>(ctx.app, cookie, 'POST', `/api/technician-admin/rotas/${id}/apply?from=${from}&days=${days}`, body);
const cellOf = (v: ScheduleView, no: string, date: string) => v.cells.find((c) => c.technicianId === tech[no] && c.date === date) ?? null;

beforeAll(async () => {
  ctx = await setup();
  for (const [no, name] of [
    ['21', '中医甲'],
    ['22', '中医乙'],
    ['23', '中医丙'],
    ['24', '足浴丁'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name, gender: 'female', grade: 'standard' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  for (const [name, start, end] of [
    ['中医早班', 600, 1080],
    ['中医晚班', 1080, 120],
    ['旧班', 0, 60],
  ] as const) {
    const r = await api<TechnicianAdminView>(ctx.app, ctx.owner, 'POST', '/api/technician-admin/shifts', { name, startMinute: start, endMinute: end });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const v = (await api<TechnicianAdminView>(ctx.app, ctx.owner, 'GET', '/api/technician-admin')).body;
  today = v.businessDate;
  const id = (name: string) => v.shifts.find((s) => s.name === name)!.id;
  [early, late, parked] = [id('中医早班'), id('中医晚班'), id('旧班')];
  expect((await api(ctx.app, ctx.owner, 'PUT', `/api/technician-admin/shifts/${parked}`, { name: '旧班', startMinute: 0, endMinute: 60, active: false })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('轮班清单', () => {
  it('整份保存：按周期轮转要起算日；班次要在用；名字不能重复；新建的编号接着排；钟房的岗位只能看', async () => {
    expect(await rotas()).toEqual([]);
    const week = {
      name: '足浴七天',
      mode: 'cycle',
      anchor: today,
      segments: [
        { days: 5, shiftId: early },
        { days: 2, shiftId: null },
      ],
    };
    const tcm = {
      name: '中医十天',
      mode: 'monthly',
      anchor: today,
      segments: [
        { days: 10, shiftId: early },
        { days: 10, shiftId: late },
        { days: 10, shiftId: null },
      ],
    };
    expect((await save([week], ctx.clerk)).status).toBe(403);
    expect((await save([{ ...week, anchor: null }])).status).toBe(400);
    expect((await save([week, { ...tcm, name: '足浴七天' }])).status).toBe(400);
    expect((await save([{ ...week, segments: [] }])).status).toBe(400);
    expect((await save([{ ...week, segments: [{ days: 32, shiftId: early }] }])).status).toBe(400);
    expect((await save([{ ...week, segments: [{ days: 3, shiftId: parked }] }])).body.error.code).toBe('ROTA_SHIFT_INVALID');
    expect((await save([{ ...week, segments: [{ days: 3, shiftId: 999_999 }] }])).body.error.code).toBe('ROTA_SHIFT_INVALID');
    const r = await save([week, tcm]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // 每月 1 日固定转班不存起算日
    expect(r.body.rotas.map((x) => [x.id, x.name, x.mode, x.anchor])).toEqual([
      [1, '足浴七天', 'cycle', today],
      [2, '中医十天', 'monthly', null],
    ]);
    expect(await rotas()).toEqual(r.body.rotas);
    // 改名、删掉第一个、再新建一个：原来的编号不变，新的接着最大号往后排
    const again = await save([
      { ...tcm, id: 2, name: '中医十天转' },
      { ...week, name: '临时' },
    ]);
    expect(again.body.rotas.map((x) => [x.id, x.name])).toEqual([
      [2, '中医十天转'],
      [3, '临时'],
    ]);
    const [audit] = await ctx.sql<{ detail: { key: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'settings_updated' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.key).toBe('technician_rotas');
  });
});

describe('按轮班生成排班', () => {
  it('每月 1 日固定转班：三位错开、跳过没变的；与排班同一条路留痕与审计', async () => {
    const list = await rotas();
    const tcm = list.find((r) => r.name === '中医十天转')!;
    const from = shiftDate(today, 1);
    const offsets = { [tech['21']!]: 0, [tech['22']!]: 1, [tech['23']!]: 2 };
    const r = await applyRota(tcm.id, { technicianIds: [tech['21'], tech['22'], tech['23']], offsets, from, days: 31 }, ctx.owner, from, 31);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.changed).toBe(93);
    for (let i = 0; i < 31; i += 1) {
      const d = shiftDate(from, i);
      for (const no of ['21', '22', '23'] as const) {
        const want = rotaCellOn(tcm, d, offsets[tech[no]!]);
        expect(cellOf(r.body, no, d), `${no} ${d}`).toMatchObject({ shiftId: want.shiftId, rest: want.rest });
      }
    }
    // 31 日（若这段日子里有）按最后一段：甲排休、乙早班（错开 1 段的最后一段是第一段）
    const day31 = Array.from({ length: 31 }, (_, i) => shiftDate(from, i)).find((d) => d.endsWith('-31'));
    if (day31) {
      expect(cellOf(r.body, '21', day31)).toMatchObject({ shiftId: null, rest: true });
      expect(cellOf(r.body, '22', day31)).toMatchObject({ shiftId: early });
    }
    const [audit] = await ctx.sql<{ detail: { summary: string; rotaId: number } }[]>`SELECT detail FROM audit_logs WHERE action = 'technician_schedule' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.rotaId).toBe(tcm.id);
    expect(audit!.detail.summary).toBe(`按轮班「中医十天转」排班：${from} 至 ${shiftDate(from, 30)}，3 位技师，改了 93 格`);
    const [count] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM technician_schedule_changes WHERE kind = 'plan'`;
    expect(count!.n).toBe(93);
    // 原样再生成一次：一格都没变，不记
    const same = await applyRota(tcm.id, { technicianIds: [tech['21'], tech['22'], tech['23']], offsets, from, days: 31 }, ctx.owner, from, 31);
    expect(same.body.changed).toBe(0);
  });

  it('按周期轮转：从起算日起首尾相接；今天已经排了的、过去的照排班的规矩拒绝；权限', async () => {
    const week = (await rotas()).find((r) => r.name === '临时')!;
    const r = await applyRota(week.id, { technicianIds: [tech['24']], from: today, days: 7 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.changed).toBe(7);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => cellOf(r.body, '24', shiftDate(today, i))!.shiftId)).toEqual([early, early, early, early, early, null, null]);
    expect(cellOf(r.body, '24', shiftDate(today, 6))!.rest).toBe(true);
    // 换成错开 1 段：今天已经排了早班，要改得走临时调班
    const locked = await applyRota(week.id, { technicianIds: [tech['24']], offsets: { [tech['24']!]: 1 }, from: today, days: 7 });
    expect(locked.status).toBe(422);
    expect(locked.body.error.code).toBe('SCHEDULE_TODAY_NEEDS_REASON');
    expect((await applyRota(week.id, { technicianIds: [tech['24']], from: shiftDate(today, -1), days: 2 })).body.error.code).toBe('SCHEDULE_PAST');
    expect((await applyRota(week.id, { technicianIds: [tech['24']], from: today, days: 32 })).status).toBe(400);
    expect((await applyRota(week.id, { technicianIds: [], from: today, days: 3 })).status).toBe(400);
    expect((await applyRota(999, { technicianIds: [tech['24']], from: today, days: 3 })).status).toBe(404);
    expect((await applyRota(week.id, { technicianIds: [tech['24']], from: today, days: 3 }, ctx.clerk)).status).toBe(403);
  });

  it('轮班里的班次后来停用了：生成时照排班的规矩拒绝', async () => {
    const week = (await rotas()).find((r) => r.name === '临时')!;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/technician-admin/shifts/${early}`, { name: '中医早班', startMinute: 600, endMinute: 1080, active: false })).status).toBe(200);
    const r = await applyRota(week.id, { technicianIds: [tech['21']], from: shiftDate(today, 40), days: 7 });
    expect(r.body.error.code).toBe('SCHEDULE_SHIFT_INVALID');
  });
});
