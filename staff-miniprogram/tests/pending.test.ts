// 「结果待确认」（src/utils/pending.ts）：先存再发、存不下就不发；成功或门店明确拒绝删掉；超时、连不上、5xx、没登录留着，
// 按原编号原样重提；原样重提被拒的打卡、申请、审批先作废原编号再下结论；同一处留着一笔时不发新的（手机上没有「放弃」）；按人分开存。

import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeWx } from './fake-wx';
import { clearToken, saveToken, setRelogin, setRetryDelayForTest } from '../src/utils/api';
import type { PendingOp } from '../src/utils/pending';
import { listPending, loadPending, savePending, sendPending } from '../src/utils/pending';

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

  it('按人、按类列出留着的（学堂开新卷、进学习页时先把以前没确定的原样重提掉）', () => {
    savePending(op({ kind: 'academy_complete', key: 'a', ref: 3, body: {} }));
    savePending(op({ kind: 'academy_complete', key: 'b', ref: 4, body: {} }));
    savePending(op({ kind: 'academy_complete', key: 'c', ref: 3, body: {}, staffId: 8 }));
    savePending(op({ kind: 'academy_daily', key: 'd', ref: 3 }));
    expect(listPending(7, 'academy_complete').map((p) => p.key).sort()).toEqual(['a', 'b']);
    expect(listPending(8, 'academy_complete').map((p) => p.key)).toEqual(['c']);
    expect(listPending(7, 'academy_quiz')).toEqual([]);
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

  it('原样重提被关卡挡下（要先改密码、换了门店、没权限）：不能断定之前那次没生效，留着', async () => {
    fake.reply({ status: 0, fail: true });
    expect((await sendPending(op())).status).toBe('unknown');
    for (const code of ['PASSWORD_CHANGE_REQUIRED', 'POSITION_REQUIRED', 'FORBIDDEN']) {
      fake.reply({ status: 403, data: { error: { code, message: code } } });
      expect((await sendPending(op())).status, code).toBe('unknown');
      expect(loadPending(7, 'punch'), code).toMatchObject({ key: 'k-1' });
    }
    // 门店系统看了这一笔再拒绝的（不在打卡范围）：先作废原编号，作废登记上了才删掉
    fake.reply({ status: 422, data: { error: { code: 'LOCATION_OUT', message: '不在打卡范围内' } } }, { status: 200, data: { found: false, abandoned: true } });
    const r = await sendPending(op());
    expect(r.status).toBe('rejected');
    expect(r.status === 'rejected' && (r.error as { code: string }).code).toBe('LOCATION_OUT');
    expect(loadPending(7, 'punch')).toBeNull();
  });

  it('原样重提被拒：打卡、申请、审批先作废原编号——前一次已经办了的，再原样重提拿回原来那一次', async () => {
    fake.reply({ status: 0, fail: true });
    expect((await sendPending(op())).status).toBe('unknown');
    fake.reply(
      { status: 422, data: { error: { code: 'LOCATION_OUT', message: '不在打卡范围内' } } },
      { status: 200, data: { found: true, abandoned: false, refId: 5 } },
      { status: 200, data: { punch: { id: 5 }, replayed: true } },
    );
    expect(await sendPending(op())).toEqual({ status: 'ok', data: { punch: { id: 5 }, replayed: true } });
    expect(fake.sent.slice(1).map((s) => [s.url.replace(/^.*\/api\/staffmp/, ''), s.data])).toEqual([
      ['/oa/attendance/punch', { clientKey: 'k-1', storeId: 1 }],
      ['/ops/k-1/abandon', { type: 'oa_punch' }],
      ['/oa/attendance/punch', { clientKey: 'k-1', storeId: 1 }],
    ]);
    expect(loadPending(7, 'punch')).toBeNull();
  });

  it('原样重提被拒、作废没有明确结果（连不上、被拒、两样都不是）：留着，不断定没生效', async () => {
    const act = op({ kind: 'approval_act', ref: 12, path: '/oa/approvals/12/act', body: { clientKey: 'k-1', action: 'approve' } });
    fake.reply({ status: 0, fail: true });
    expect((await sendPending(act)).status).toBe('unknown');
    const rejected = { status: 409, data: { error: { code: 'APPROVAL_CLOSED', message: '这张单已撤销' } } };
    for (const fence of [{ status: 0, fail: true }, { status: 409, data: { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'x' } } }, { status: 200, data: { found: false, abandoned: false } }]) {
      fake.reply(rejected, fence);
      expect((await sendPending(act)).status).toBe('unknown');
      expect(loadPending(7, 'approval_act', 12)).toMatchObject({ key: 'k-1' });
    }
    expect(fake.sent.filter((s) => s.url.includes('/ops/')).map((s) => s.data)).toEqual([0, 1, 2].map(() => ({ type: 'oa_approval_act' })));
  });

  it('原样重提撞上「换了门店」：打卡、申请、审批也先作废原编号——办了的算办好了（拿不回原来的结果），没办的算被拒（独立复查）', async () => {
    const switched = { status: 409, data: { error: { code: 'STORE_SWITCHED', message: '这次打卡是在别的门店的页面上发的' } } };
    // 前一次已经打上了：作废回 found，再重提照旧被门店挡下 → 算办好了，删掉这一笔
    fake.reply({ status: 0, fail: true });
    expect((await sendPending(op())).status).toBe('unknown');
    fake.reply(switched, { status: 200, data: { found: true, abandoned: false, refId: 41 } }, switched);
    expect(await sendPending(op())).toEqual({ status: 'confirmed', refId: 41 });
    expect(loadPending(7, 'punch')).toBeNull();
    // 前一次没办：作废登记上 → 算被拒，删掉，交出门店的话
    fake.reply({ status: 0, fail: true });
    expect((await sendPending(op({ key: 'k-2', body: { clientKey: 'k-2', storeId: 1 } }))).status).toBe('unknown');
    fake.reply(switched, { status: 200, data: { found: false, abandoned: true } });
    const r = await sendPending(op({ key: 'k-2', body: { clientKey: 'k-2', storeId: 1 } }));
    expect(r.status === 'rejected' && (r.error as { code: string }).code).toBe('STORE_SWITCHED');
    expect(loadPending(7, 'punch')).toBeNull();
    // 学堂的（没有作废）撞上换了门店：照旧留着
    const quiz = op({ kind: 'academy_quiz', ref: 3, key: 'k-3', path: '/academy/lessons/3/quiz', body: { clientKey: 'k-3' } });
    fake.reply({ status: 0, fail: true });
    expect((await sendPending(quiz)).status).toBe('unknown');
    fake.reply(switched);
    expect((await sendPending(quiz)).status).toBe('unknown');
    expect(loadPending(7, 'academy_quiz', 3)).toMatchObject({ key: 'k-3' });
  });

  it('学堂的几样没有作废：原样重提被拒就算被拒', async () => {
    const quiz = op({ kind: 'academy_quiz', ref: 3, path: '/academy/lessons/3/quiz', body: { clientKey: 'k-1' } });
    fake.reply({ status: 0, fail: true });
    expect((await sendPending(quiz)).status).toBe('unknown');
    fake.reply({ status: 409, data: { error: { code: 'LESSON_CHANGED', message: '课时改过了' } } });
    expect((await sendPending(quiz)).status).toBe('rejected');
    expect(fake.sent.some((s) => s.url.includes('/ops/'))).toBe(false);
    expect(loadPending(7, 'academy_quiz', 3)).toBeNull();
  });

  it('第一次发就被关卡挡下：门店系统没收这一笔，删掉', async () => {
    fake.reply({ status: 403, data: { error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '首次登录请先修改密码' } } });
    expect((await sendPending(op())).status).toBe('rejected');
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
