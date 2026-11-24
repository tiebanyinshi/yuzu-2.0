// 8.1.35 福田迁移第二批：技师名册导入（docs/FUTIAN_MIGRATION.md 第 2.4 节）。全部是合成数据。
//   · 认旧系统「技师导入模板」的表头（前面有填写须知也行）；性别必填、等级没写按标准、Excel 日期序号与文字日期都认；
//   · 在第二家店里导：技师号已有的跳过、组别没有的建、按组别跳过（测试组）；只预览不写；再导一次什么都不建。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyDate, parseGradeMap, parseTechnicianTable } from '../src/shared/technician-import';
import { importTechnicians } from '../src/server/modules/technician-import';
import { runInStore } from '../src/server/lib/store-context';
import { api, setup, type TestContext } from './helpers';

const HEADER = ['技师号', '姓名', '性别', '手机号', '技师类型', '技师等级', '入职日期', '是否挂牌', '挂牌日期', '技师组别', '昵称'];

describe('技师导入模板解析', () => {
  it('日期：Excel 序号、文字日期；认不出来的报出来', () => {
    expect(legacyDate('44965')).toBe('2023-02-08');
    expect(legacyDate('2021-05-06 00:00:00')).toBe('2021-05-06');
    expect(legacyDate('2021/5/6')).toBe('2021-05-06');
    expect(legacyDate('')).toBeNull();
    expect(legacyDate('2021-02-30')).toBeUndefined();
    expect(legacyDate('昨天')).toBeUndefined();
  });

  it('旧系统的星级按 --grade-map 对照；写错的对照报出来', () => {
    const map = parseGradeMap('一星=标准，五星=专业, 七星=优选');
    expect(map).toEqual({ 一星: 'standard', 五星: 'professional', 七星: 'premium' });
    const p = parseTechnicianTable([HEADER, ['1', '甲', '女', '', '', '五星', '', '', '', '', ''], ['2', '乙', '女', '', '', '八星', '', '', '', '', '']], {
      gradeMap: map as Record<string, 'standard'>,
    });
    expect(p.rows.map((r) => r.grade)).toEqual(['professional']);
    expect(p.errors[0]!.message).toContain('--grade-map');
    expect(parseGradeMap('一星=资深')).toContain('看不懂');
  });

  it('表头前有填写须知也认；性别必填、等级没写按标准、技师号格式与重复报出来', () => {
    const p = parseTechnicianTable([
      ['填写须知：请勿修改表头'],
      HEADER,
      ['9001', '甲', '女', '', '', '', '44965', '是', '', '按摩师A组', '小甲'],
      ['9002', '乙', '男', '', '', '专业', '2024-08-27', '是', '', '', ''],
      ['9003', '丙', '', '', '', '', '', '是', '', '', ''],
      ['9001', '丁', '女', '', '', '', '', '是', '', '', ''],
      ['ABCDEFG', '戊', '女', '', '', '资深', '', '是', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', ''],
    ]);
    expect(p.rows).toEqual([
      { line: 3, techNo: '9001', name: '甲', gender: 'female', grade: 'standard', group: '按摩师A组', nickname: '小甲', hiredOn: '2023-02-08' },
      { line: 4, techNo: '9002', name: '乙', gender: 'male', grade: 'professional', group: null, nickname: '', hiredOn: '2024-08-27' },
    ]);
    expect(p.errors.map((e) => e.line)).toEqual([5, 6, 7]);
    expect(p.errors[0]!.message).toContain('性别');
    expect(p.errors[1]!.message).toContain('重复');
    expect(p.errors[2]!.message).toMatch(/技师号.*等级|1–6 位/);
    expect(parseTechnicianTable([['a', 'b']]).errors[0]!.message).toContain('表头');
  });
});

let ctx: TestContext;
let storeId = 0;
beforeAll(async () => {
  ctx = await setup();
  const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '技师导入主体' });
  storeId = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'TI', name: '技师导入店', entityId: entity.body.id })).body.id as number;
}, 90_000);
afterAll(async () => ctx.close());

describe('技师名册导入（第二家店）', () => {
  it('预览不写；导入建技师与分组（测试组跳过）；技师号已有的跳过；再导一次什么都不建；本店不受影响', async () => {
    const parsed = parseTechnicianTable([
      HEADER,
      ['101', '甲', '女', '', '', '', '44965', '是', '', '按摩师A组', ''],
      ['102', '乙', '男', '', '', '优选', '', '是', '', '按摩师A组', ''],
      ['103', '丙', '女', '', '', '专业', '', '是', '', '采耳B组', ''],
      ['199', '测', '女', '', '', '', '', '是', '', '测试组', ''],
    ]);
    expect(parsed.errors).toEqual([]);
    const count = async () => (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM technicians WHERE store_id = ${storeId}`)[0]!.n;
    const dry = await runInStore(storeId, () => importTechnicians(ctx.sql, parsed.rows, { apply: false, staffId: null, skipGroups: ['测试组'] }));
    expect(dry).toMatchObject({ total: 4, created: 3, existing: [], skippedByGroup: 1, groupsCreated: ['按摩师A组', '采耳B组'], byGrade: { standard: 1, premium: 1, professional: 1 } });
    expect(await count()).toBe(0);
    // 本店已有一位 101：不影响第二家店
    await ctx.sql`INSERT INTO technicians (store_id, tech_no, name, gender, grade) VALUES (1, '101', '本店甲', 'female', 'standard') ON CONFLICT DO NOTHING`;
    const done = await runInStore(storeId, () => importTechnicians(ctx.sql, parsed.rows, { apply: true, staffId: null, skipGroups: ['测试组'] }));
    expect(done.created).toBe(3);
    const rows = await ctx.sql<{ techNo: string; grade: string; hiredOn: string | null; groupName: string | null }[]>`
      SELECT t.tech_no, t.grade, to_char(t.hired_on, 'YYYY-MM-DD') AS hired_on, g.name AS group_name
      FROM technicians t LEFT JOIN technician_groups g ON g.id = t.group_id WHERE t.store_id = ${storeId} ORDER BY t.tech_no`;
    expect(rows).toEqual([
      { techNo: '101', grade: 'standard', hiredOn: '2023-02-08', groupName: '按摩师A组' },
      { techNo: '102', grade: 'premium', hiredOn: null, groupName: '按摩师A组' },
      { techNo: '103', grade: 'professional', hiredOn: null, groupName: '采耳B组' },
    ]);
    const again = await runInStore(storeId, () => importTechnicians(ctx.sql, parsed.rows, { apply: true, staffId: null, skipGroups: ['测试组'] }));
    expect(again).toMatchObject({ created: 0, existing: ['101', '102', '103'], groupsCreated: [] });
    expect(await count()).toBe(3);
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM technician_groups WHERE store_id = ${storeId}`)[0]!.n).toBe(2);
    const [audit] = await ctx.sql<{ detail: { created: number } }[]>`SELECT detail FROM audit_logs WHERE action = 'technicians_imported' ORDER BY id DESC LIMIT 1`;
    expect(audit!.detail.created).toBe(3);
  });
});
