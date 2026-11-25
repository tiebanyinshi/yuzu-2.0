// 8.1.35 福田迁移：手牌导入认旧收银系统「手牌管理导入模板」的表头与手牌 ID（芯片号）（docs/FUTIAN_MIGRATION.md 第 2.8 节）。全部是合成数据。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHandTagCsv, parseHandTagTable } from '../src/shared/hand-tag-import';
import { api, setup, type TestContext } from './helpers';

describe('旧模板解析', () => {
  it('表头前的填写须知跳过；手牌号、手牌ID、性别、手牌类型都认；旧的手牌类型当普通柜；芯片号格式与重复报出来', () => {
    const p = parseHandTagTable([
      ['填写须知：请勿修改表头'],
      ['手牌号', '手牌ID', '适用对象', '性别', '手牌区域', '手牌类型', '客人姓名', '柜锁ID', '手牌备注'],
      ['8001', '0007848034', '成人', '男', 'T区', '散客', '', '', ''],
      ['8002', '', '儿童', '女', '共用柜', '儿童', '', '', ''],
      ['8003', '0007848034', '成人', '男', '', '散客', '', '', ''],
      ['8004', '12', '成人', '男', '', '散客', '', '', ''],
      ['8005', 'abcd1234', '虚拟', '女', '', '虚拟', '', '', ''],
    ]);
    expect(p.rows).toEqual([
      { code: '8001', zone: 'male', kind: 'normal', vipLevel: null, cardUid: '0007848034' },
      { code: '8002', zone: 'female', kind: 'normal', vipLevel: null, cardUid: null },
      { code: '8005', zone: 'female', kind: 'normal', vipLevel: null, cardUid: 'ABCD1234' },
    ]);
    expect(p.errors.map((e) => e.line)).toEqual([5, 6]);
    expect(p.errors[0]!.message).toContain('重复');
    expect(p.errors[1]!.message).toContain('4–32');
    // 原来的 CSV 格式照旧（没有芯片号这一列：不带 cardUid）
    expect(parseHandTagCsv('code,gender,kind\nA1,male,normal\n').rows).toEqual([{ code: 'A1', zone: 'male', kind: 'normal', vipLevel: null }]);
  });
});

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
}, 90_000);
afterAll(async () => ctx.close());

describe('导入芯片号', () => {
  it('新建带芯片号；已有的手牌补上芯片号算更新；芯片号已绑在别的牌上的不导（牌照常导）；清单里芯片号空的不解绑', async () => {
    const post = (rows: unknown[], dryRun = false) => api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/import', { rows, dryRun });
    const r1 = await post([
      { code: 'R101', zone: 'male', kind: 'normal', vipLevel: null, cardUid: 'AAAA0001' },
      { code: 'R102', zone: 'male', kind: 'normal', vipLevel: null },
    ]);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const uid = async (code: string) => (await ctx.sql<{ cardUid: string | null }[]>`SELECT card_uid FROM hand_tags WHERE code = ${code}`)[0]!.cardUid;
    expect(await uid('R101')).toBe('AAAA0001');
    expect(await uid('R102')).toBeNull();
    const r2 = await post([
      { code: 'R101', zone: 'male', kind: 'normal', vipLevel: null, cardUid: null },
      { code: 'R102', zone: 'male', kind: 'normal', vipLevel: null, cardUid: 'BBBB0002' },
      { code: 'R103', zone: 'female', kind: 'normal', vipLevel: null, cardUid: 'AAAA0001' },
    ]);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body).toMatchObject({ created: 1, updated: 1, unchanged: 1 });
    expect(r2.body.blocked).toEqual([expect.objectContaining({ code: 'R103' })]);
    expect(await uid('R101')).toBe('AAAA0001');
    expect(await uid('R102')).toBe('BBBB0002');
    expect(await uid('R103')).toBeNull();
  });
});
