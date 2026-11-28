// 吃饭与巡场的手机端（src/utils/canteen.ts）：扫到的先存再交（存不下不发）；明确结果删掉、结果不明留着按原编号补交；
// 按员工分开存；码的认法与主线一致；菜单按天按餐排；文字与主线的一致。

import { beforeEach, describe, expect, it } from 'vitest';
import { DISH_TAG_LABELS, MEAL_LABELS as SHARED_MEAL_LABELS, mealWindowText as sharedMealWindowText } from '../../src/shared/canteen';
import type { CanteenMenu, CheckinResult } from '../../src/shared/canteen';
import { parsePatrolToken } from '../../src/shared/patrol';
import { installFakeWx } from './fake-wx';
import { clearToken, saveToken, setRelogin, setRetryDelayForTest } from '../src/utils/api';
import type { QueuedScan } from '../src/utils/canteen';
import {
  MEAL_LABELS,
  TAG_LABELS,
  dropMealKey,
  enqueue,
  flushQueue,
  isMealCode,
  loadMealKey,
  loadQueue,
  mealCodeEmployee,
  mealNow,
  mealWindowText,
  menuDays,
  patrolCodeOf,
  shiftDate,
  submitScan,
} from '../src/utils/canteen';

let fake: ReturnType<typeof installFakeWx>;

const scan = (clientKey: string, over: Partial<QueuedScan['body']> = {}): QueuedScan => ({
  kind: 'checkin',
  body: { clientKey, code: 'YZC1:1:A:AAAAAAAA', scannedAt: '2026-11-27T04:00:00.000Z', ...over },
  label: '扫到的饭卡码',
  savedAt: 1,
});

const ok = (id: number): CheckinResult => ({ status: 'ok', mealCount: id, checkin: { id } as CheckinResult['checkin'] });

beforeEach(() => {
  fake = installFakeWx();
  clearToken();
  saveToken('tok');
  setRelogin(null);
  setRetryDelayForTest(() => 0);
});

describe('扫到的先存再交', () => {
  it('交上了：从手机上删掉', async () => {
    const item = scan('k1');
    expect(enqueue(5, item)).toBe(true);
    fake.reply({ status: 200, data: ok(1) });
    const r = await submitScan<CheckinResult>(5, item);
    expect(r.kind).toBe('done');
    expect(loadQueue('checkin', 5)).toEqual([]);
    expect(fake.sent[0]!.url).toContain('/api/staffmp/canteen/checkins');
    expect(fake.sent[0]!.data).toEqual(item.body);
  });

  it('门店明确拒绝（码过期、不在开饭时间）：删掉，不再补交', async () => {
    const item = scan('k2');
    enqueue(5, item);
    fake.reply({ status: 422, data: { error: { code: 'CODE_EXPIRED', message: '码过期了' } } });
    const r = await submitScan<CheckinResult>(5, item);
    expect(r.kind).toBe('rejected');
    expect(loadQueue('checkin', 5)).toEqual([]);
  });

  it('连不上、5xx：留着，补交时用原来的操作编号', async () => {
    const item = scan('k3');
    enqueue(5, item);
    fake.reply({ status: 0, fail: true });
    expect((await submitScan<CheckinResult>(5, item)).kind).toBe('queued');
    expect(loadQueue('checkin', 5).map((x) => x.body.clientKey)).toEqual(['k3']);

    fake.reply({ status: 502, data: {} });
    const left = await flushQueue<CheckinResult>('checkin', 5, () => undefined);
    expect(left).toBe(1);

    const seen: string[] = [];
    fake.reply({ status: 200, data: ok(3) });
    expect(await flushQueue<CheckinResult>('checkin', 5, (it) => seen.push(it.body.clientKey))).toBe(0);
    expect(seen).toEqual(['k3']);
    expect(fake.pending()).toBe(0);
    expect(fake.sent.every((s) => (s.data as { clientKey: string }).clientKey === 'k3')).toBe(true);
  });

  it('登录过期（重新登录也不行）：留着，标出是登录过期', async () => {
    const item = scan('k401');
    enqueue(5, item);
    fake.reply({ status: 401, data: { error: { code: 'UNAUTHORIZED', message: '请先登录' } } });
    const r = await submitScan<CheckinResult>(5, item);
    expect(r).toEqual({ kind: 'queued', expired: true });
    expect(loadQueue('checkin', 5).map((x) => x.body.clientKey)).toEqual(['k401']);
  });

  it('补交时另一轮已经交掉的不再发', async () => {
    enqueue(5, scan('x1'));
    enqueue(5, scan('x2'));
    // 第一笔交上的同时，另一轮把第二笔也交掉了（从手机上删掉）
    fake.reply({ status: 200, data: ok(1) });
    const wx = (globalThis as unknown as { wx: { request: (o: { success: (r: unknown) => void }) => void } }).wx;
    const original = wx.request;
    wx.request = (o) => {
      fake.storage.set('wcp_scan_q:checkin:5', []);
      original(o as never);
    };
    await flushQueue<CheckinResult>('checkin', 5, () => undefined);
    expect(fake.sent.length).toBe(1);
  });

  it('补交按顺序，遇到还是结果不明的就停', async () => {
    enqueue(5, scan('a'));
    enqueue(5, scan('b'));
    fake.reply({ status: 200, data: ok(1) }, { status: 0, fail: true });
    const left = await flushQueue<CheckinResult>('checkin', 5, () => undefined);
    expect(left).toBe(1);
    expect(loadQueue('checkin', 5).map((x) => x.body.clientKey)).toEqual(['b']);
  });

  it('按员工分开存：换了人登录，上一位的不会交到这一位名下', () => {
    enqueue(5, scan('mine'));
    expect(loadQueue('checkin', 6)).toEqual([]);
    expect(loadQueue('patrol', 5)).toEqual([]);
  });

  it('存不下（读回对不上）就返回 false，调用方不得发出', () => {
    const wx = (globalThis as unknown as { wx: { setStorageSync: (k: string, v: unknown) => void } }).wx;
    wx.setStorageSync = () => {
      throw new Error('满了');
    };
    expect(enqueue(5, scan('x'))).toBe(false);
    expect(fake.sent).toEqual([]);
  });
});

describe('码的认法', () => {
  it('巡场码与主线的 parsePatrolToken 认法一致', () => {
    const samples = [
      'https://staff.yuzusystem.xyz/#patrol=ABCDEFGHJKLM',
      'https://staff.yuzusystem.xyz/#/patrol=abcdefghjklm',
      'https://staff.yuzusystem.xyz/#patrol/ABCDEFGHJKLM&x=1',
      'ABCDEFGHJKLM',
      'abcdefghjklm',
      'ABCDEFGHJKL',
      'ABCDEFGHJKL1',
      'https://example.com/#patrol=ABCDEFGHJKLMN',
      'YZC1:1:A:AAAAAAAA',
      '',
    ];
    for (const s of samples) expect(patrolCodeOf(s), s).toBe(parsePatrolToken(s));
  });

  it('微信扫一扫打开时码是编码过的网址', () => {
    expect(patrolCodeOf(encodeURIComponent('https://staff.yuzusystem.xyz/#patrol=ABCDEFGHJKLM'))).toBe('ABCDEFGHJKLM');
  });

  it('饭卡码里的员工编号（负责人按人去重）', () => {
    expect(mealCodeEmployee('YZC1:1A:K3B2:ABCDEFGH')).toBe(46);
    expect(mealCodeEmployee('ABCDEFGHJKLM')).toBeNull();
  });

  it('饭卡解开了删掉手机上的码钥匙', () => {
    fake.storage.set('wcp_meal_key:7', { staffId: 7, me: { codeKey: 'k' }, offsetMs: 0, savedAt: 1 });
    expect(loadMealKey(7)).not.toBeNull();
    dropMealKey(7);
    expect(loadMealKey(7)).toBeNull();
  });

  it('饭卡码', () => {
    expect(isMealCode('YZC1:1A:K3B2:ABCDEFGH')).toBe(true);
    expect(isMealCode('yzc1:1a:k3b2:abcdefgh')).toBe(true);
    expect(isMealCode('YZC1:1A:K3B2:ABCDEFG')).toBe(false);
    expect(isMealCode('ABCDEFGHJKLM')).toBe(false);
  });
});

describe('开饭时间与菜单', () => {
  const meals = [
    { meal: 'lunch' as const, start: '10:30', end: '14:00', enabled: true },
    { meal: 'supper' as const, start: '22:00', end: '02:00', enabled: true },
    { meal: 'dinner' as const, start: '16:30', end: '19:00', enabled: false },
  ];
  it('此刻是哪一餐（跨午夜的夜宵、停用的不算）', () => {
    expect(mealNow(meals, '11:00')!.meal).toBe('lunch');
    expect(mealNow(meals, '14:00')).toBeNull();
    expect(mealNow(meals, '23:30')!.meal).toBe('supper');
    expect(mealNow(meals, '01:59')!.meal).toBe('supper');
    expect(mealNow(meals, '17:00')).toBeNull();
  });

  it('文字与主线一致', () => {
    expect(MEAL_LABELS).toEqual(SHARED_MEAL_LABELS);
    expect(TAG_LABELS).toEqual(DISH_TAG_LABELS);
    for (const w of meals) expect(mealWindowText(w)).toBe(sharedMealWindowText(w));
  });

  it('日期往后挪（跨月、跨年）', () => {
    expect(shiftDate('2026-11-27', 6)).toBe('2026-12-03');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('菜单按天、按餐排，赞数与我点过的', () => {
    const menu = (id: number, date: string, meal: CanteenMenu['meal']): CanteenMenu => ({
      id,
      date,
      meal,
      dishes: [
        { id: 'a', name: '番茄炒蛋', emoji: '', tags: ['new', 'veg'] },
        { id: 'b', name: '红烧肉', emoji: '🍖', tags: [] },
      ],
      note: '',
      published: true,
      version: 1,
      updatedAt: '',
      updatedByName: null,
      likes: { a: 3 },
      myLikes: ['a'],
    });
    const days = menuDays([menu(2, '2026-11-28', 'lunch'), menu(3, '2026-11-27', 'dinner'), menu(1, '2026-11-27', 'lunch')], '2026-11-27');
    expect(days.map((d) => d.date)).toEqual(['2026-11-27', '2026-11-28']);
    expect(days[0]!.label.startsWith('今天 · ')).toBe(true);
    expect(days[1]!.label.startsWith('明天 · ')).toBe(true);
    expect(days[0]!.meals.map((m) => m.meal)).toEqual(['午餐', '晚餐']);
    const [a, b] = days[0]!.meals[0]!.dishes;
    expect(a).toMatchObject({ menuId: 1, id: 'a', emoji: '🍚', tags: '新 · 素', likes: 3, liked: true });
    expect(b).toMatchObject({ emoji: '🍖', tags: '', likes: 0, liked: false });
  });
});
