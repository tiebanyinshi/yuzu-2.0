// 巡场页与巡场记录页（src/utils/patrol.ts）：照门店系统回的这一天显示，正在巡的这一轮还差几个、漏巡、谁巡的；扫完的一句话。

import { describe, expect, it } from 'vitest';
import type { PatrolCheckinResult, PatrolPortalDay, PatrolScan } from '../../src/shared/patrol';
import { installFakeWx } from './fake-wx';
import { hasPatrolLink, patrolResultText, patrolView, savePatrolLink, takePatrolLink } from '../src/utils/patrol';

const scanAt = (iso: string, name = '王五'): PatrolScan => ({ id: 1, at: iso, employeeId: 9, name, empNo: 'A9', via: 'scan', late: false });

// 门店时区 +8：第 1 轮 08:00–11:00、第 2 轮 11:00–14:00（正在巡）、第 3 轮 14:00–17:00
const day: PatrolPortalDay = {
  date: '2026-11-27',
  today: '2026-11-27',
  roundMinutes: 180,
  rounds: [
    { no: 1, start: '2026-11-27T00:00:00.000Z', end: '2026-11-27T03:00:00.000Z', state: 'past', expected: 2, done: 1 },
    { no: 2, start: '2026-11-27T03:00:00.000Z', end: '2026-11-27T06:00:00.000Z', state: 'current', expected: 2, done: 1 },
    { no: 3, start: '2026-11-27T06:00:00.000Z', end: '2026-11-27T09:00:00.000Z', state: 'future', expected: 2, done: 0 },
  ],
  currentRound: 2,
  points: [
    { id: 1, name: '前台', area: '一楼', active: true, count: 2, scans: [], byRound: [[scanAt('2026-11-27T01:05:00.000Z')], [scanAt('2026-11-27T03:10:00.000Z')], []] },
    { id: 2, name: '锅炉房', area: '', active: true, count: 0, scans: [], byRound: [[], [], []] },
    { id: 3, name: '旧仓库', area: '', active: false, count: 0, scans: [], byRound: [null, null, null] },
  ],
  people: [{ employeeId: 9, name: '王五', empNo: 'A9', count: 2 }],
  total: 2,
  missed: 1,
  currentMissing: 1,
  mine: 2,
  canViewHistory: true,
};

describe('巡场页', () => {
  it('看正在巡的这一轮：还差几个，没巡的排在前面，这一轮不用巡的不列', () => {
    const v = patrolView(day);
    expect(v.roundNo).toBe(2);
    expect(v.roundText).toBe('第 2 轮 · 11:00–14:00');
    expect(v.progress).toBe('这一轮还差 1 个场所');
    expect(v.points.map((p) => [p.name, p.state, p.text])).toEqual([
      ['锅炉房', 'todo', '还没巡'],
      ['前台', 'done', '11:10 王五'],
    ]);
  });

  it('过去的一轮：没巡的写漏巡；各轮标出漏了的', () => {
    const v = patrolView(day, 1);
    expect(v.progress).toBe('这一轮漏了 1 个场所');
    expect(v.points[0]).toMatchObject({ name: '锅炉房', text: '漏巡' });
    expect(v.rounds.map((r) => r.missed)).toEqual([true, false, false]);
    expect(v.rounds[0]!.time).toBe('08:00–11:00');
  });

  it('以前的一天（没有正在巡的）看最后一轮', () => {
    const v = patrolView({ ...day, currentRound: null });
    expect(v.roundNo).toBe(3);
  });

  it('这一轮都巡过了', () => {
    const all = { ...day, points: [day.points[0]!] };
    expect(patrolView(all).progress).toBe('这一轮都巡过了');
    expect(patrolView(all).allDone).toBe(true);
  });

  it('扫完的一句话：记上了、这一轮别人已经巡过', () => {
    const r = (status: 'ok' | 'already', mine: boolean): PatrolCheckinResult => ({
      status,
      checkin: { id: 1, pointName: '前台', area: '一楼', at: '2026-11-27T03:10:00.000Z', late: false, employeeName: '王五', mine },
      round: { no: 2, start: '', end: '' },
      pointCount: 3,
    });
    expect(patrolResultText(r('ok', true))).toEqual({ tone: 'ok', title: '✓ 前台', sub: '第 2 轮 · 一楼 · 今天这里巡了 3 次' });
    expect(patrolResultText(r('already', false)).sub).toBe('王五在 11:10 打过卡，不再多记');
    expect(patrolResultText(r('already', true)).sub).toBe('你在 11:10 打过卡，不再多记');
  });

  it('微信扫一扫打开时的码：存下，取一次就没了', () => {
    installFakeWx();
    savePatrolLink('ABCDEFGHJKLM');
    // 要先登录的：登录完回到首页，首页看得到有码等着交（只看不取），转去巡场页由那里取走
    expect(hasPatrolLink()).toBe(true);
    expect(hasPatrolLink()).toBe(true);
    expect(takePatrolLink()!.code).toBe('ABCDEFGHJKLM');
    expect(hasPatrolLink()).toBe(false);
    expect(takePatrolLink()).toBeNull();
  });
});
