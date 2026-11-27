// 接口层（src/utils/api.ts）：前缀与令牌、过期时悄悄重新登录再重发一次、忙时带原编号短暂重发、错误文字原样、连不上。

import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeWx } from './fake-wx';
import { call, clearToken, publicCall, saveToken, setRelogin, setRetryDelayForTest } from '../src/utils/api';

let fake: ReturnType<typeof installFakeWx>;

beforeEach(() => {
  fake = installFakeWx();
  clearToken();
  setRelogin(null);
  setRetryDelayForTest(() => 0);
});

describe('要登录的接口', () => {
  it('地址带 /api/staffmp 前缀、带令牌；成功给数据', async () => {
    saveToken('tok-a'.padEnd(43, 'x'));
    fake.reply({ status: 200, data: { ok: 1 } });
    await expect(call('GET', '/me')).resolves.toEqual({ ok: 1 });
    expect(fake.sent[0]!.url).toBe('http://127.0.0.1:8095/api/staffmp/me');
    expect(fake.sent[0]!.header.authorization).toBe('Bearer ' + 'tok-a'.padEnd(43, 'x'));
    expect(fake.sent[0]!.data).toBeUndefined();
  });

  it('401：悄悄重新登录一次，拿新令牌重发', async () => {
    saveToken('old');
    setRelogin(async () => {
      saveToken('new');
      return true;
    });
    fake.reply({ status: 401, data: { error: { code: 'UNAUTHORIZED', message: '请先登录' } } }, { status: 200, data: { ok: 2 } });
    await expect(call('POST', '/auth/logout', {})).resolves.toEqual({ ok: 2 });
    expect(fake.sent[1]!.header.authorization).toBe('Bearer new');
    expect(fake.sent[1]!.data).toEqual({});
  });

  it('重新登录不了（没绑微信、主动退出过）：抛 401 交给页面去登录页', async () => {
    saveToken('old');
    setRelogin(async () => false);
    fake.reply({ status: 401, data: { error: { code: 'UNAUTHORIZED', message: '请先登录' } } });
    await expect(call('GET', '/me')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('没有令牌也登录不了：不发请求，直接 401', async () => {
    setRelogin(async () => false);
    await expect(call('GET', '/me')).rejects.toMatchObject({ status: 401 });
    expect(fake.sent).toHaveLength(0);
  });

  it('门店明确没处理的忙：原样重发两次；还忙就把门店的话交出去', async () => {
    saveToken('t');
    const busy = { status: 409, data: { error: { code: 'BUSY', message: '正在被别人操作' } } };
    fake.reply(busy, { status: 200, data: { ok: 3 } });
    await expect(call('POST', '/oa/approvals/1/act', { clientKey: 'k' })).resolves.toEqual({ ok: 3 });
    expect(fake.sent[1]!.data).toEqual({ clientKey: 'k' });
    fake.reply(busy, busy, busy);
    await expect(call('POST', '/x', {})).rejects.toMatchObject({ code: 'BUSY', message: '正在被别人操作' });
  });

  it('门店的错误文字原样；连不上是 NETWORK', async () => {
    saveToken('t');
    fake.reply({ status: 422, data: { error: { code: 'PUNCH_NO_GROUP', message: '你还没进这家门店的考勤组' } } });
    await expect(call('POST', '/oa/attendance/punch', {})).rejects.toMatchObject({ code: 'PUNCH_NO_GROUP', message: '你还没进这家门店的考勤组', status: 422 });
    fake.reply({ status: 0, fail: true });
    await expect(publicCall('GET', '/info')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
