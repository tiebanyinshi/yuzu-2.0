// 「结果待确认」（src/utils/pending.ts）：先存再发、存不下就不发；成功或门店明确拒绝删掉；超时、连不上、5xx、没登录留着，
// 按原编号原样重提；同一处留着一笔时不发新的（手机上没有「放弃」）；按人分开存。

import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeWx } from './fake-wx';
import { clearToken, saveToken, setRelogin, setRetryDelayForTest } from '../src/utils/api';
import type { PendingOp } from '../src/utils/pending';
import { loadPending, savePending, sendPending } from '../src/utils/pending';

let fake: ReturnType<typeof installFakeWx>;
const op = (over: Partial<PendingOp> = {}): PendingOp => ({
  staffId: 7,
  kind: 'punch',
  key: 'k-1',
  path: '/oa/attendance/punch',
  body: { clientKey: 'k-1', storeId: 1 },
  at: 1,
  label: '打卡',
  ...over,
});

beforeEach(() => {
  fake = installFakeWx();
  clearToken();
  saveToken('tok');
  setRelogin(null);
  setRetryDelayForTest(() => 0);
});

describe('结果待确认', () => {
  it('存下并读回核对；按人、类别与对象分开存', () => {
    expect(savePending(op())).toBe(true);
    expect(loadPending(7, 'punch')).toMatchObject({ key: 'k-1' });
    expect(loadPending(8, 'punch')).toBeNull();
    expect(savePending(op({ kind: 'approval_act', ref: 12 }))).toBe(true);
    expect(loadPending(7, 'approval_act', 12)).toMatchObject({ key: 'k-1' });
    expect(loadPending(7, 'approval_act', 13)).toBeNull();
  });

  it('存不下（读回对不上）就不发', async () => {
    const wx = (globalThis as unknown as { wx: { setStorageSync: (k: string, v: unknown) => void } }).wx;
    wx.setStorageSync = () => {
      throw new Error('full');
    };
    expect(await sendPending(op())).toEqual({ status: 'not_sent' });
    expect(fake.sent).toHaveLength(0);
  });

  it('成功：删掉；回的是门店系统的结果', async () => {
    fake.reply({ status: 200, data: { punch: { id: 1 } } });
    expect(await sendPending(op())).toEqual({ status: 'ok', data: { punch: { id: 1 } } });
    expect(fake.sent[0]!.data).toEqual({ clientKey: 'k-1', storeId: 1 });
    expect(loadPending(7, 'punch')).toBeNull();
  });

  it('门店明确拒绝（422）：删掉，交出原因', async () => {
    fake.reply({ status: 422, data: { error: { code: 'LOCATION_OUT', message: '不在打卡范围内' } } });
    const r = await sendPending(op());
    expect(r.status).toBe('rejected');
    expect(loadPending(7, 'punch')).toBeNull();
  });

  it('没登录（401）不算拒绝：留着，登录以后原样重提', async () => {
    fake.reply({ status: 401, data: { error: { code: 'UNAUTHORIZED', message: '请先登录' } } });
    expect((await sendPending(op())).status).toBe('signed_out');
    expect(loadPending(7, 'punch')).toMatchObject({ key: 'k-1' });
  });

  it('连不上、门店出错（5xx）：留着；没确定以前同一处不发新的；原样重提用同一个编号', async () => {
    fake.reply({ status: 0, fail: true });
    expect((await sendPending(op())).status).toBe('unknown');
    expect(loadPending(7, 'punch')).toMatchObject({ key: 'k-1' });

    // 换了编号的新一次：不发
    const fresh = await sendPending(op({ key: 'k-2', body: { clientKey: 'k-2', storeId: 1 } }));
    expect(fresh).toMatchObject({ status: 'blocked', pending: { key: 'k-1' } });
    expect(fake.sent).toHaveLength(1);
    // 别的人、别的单不受影响
    fake.reply({ status: 200, data: { ok: true } });
    expect((await sendPending(op({ staffId: 8, key: 'k-3', body: { clientKey: 'k-3' } }))).status).toBe('ok');

    fake.reply({ status: 500, data: { error: { code: 'INTERNAL', message: 'x' } } });
    expect((await sendPending(loadPending(7, 'punch')!)).status).toBe('unknown');
    fake.reply({ status: 200, data: { punch: { id: 9 }, replayed: true } });
    const again = await sendPending(loadPending(7, 'punch')!);
    expect(again.status).toBe('ok');
    expect(fake.sent.map((s) => (s.data as { clientKey: string }).clientKey)).toEqual(['k-1', 'k-3', 'k-1', 'k-1']);
    expect(loadPending(7, 'punch')).toBeNull();
  });
});
