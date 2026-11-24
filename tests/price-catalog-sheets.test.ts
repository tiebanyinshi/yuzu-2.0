// 价目表各模块单独的模板（店主 2026-11-24《价目表模板替换与页面维护需求说明》，docs/PRICE_CATALOG.md 第 9 节）：
// 门店 / 娱乐 / 房间 / 零点菜品 / 按摩及助浴各导一张表（只换草稿里的这一张，别的表照原样）、各自的模板、
// 按模板格式导出——导出的文件原样再导入，条目逐项一样（页面改过的也在），不丢、不重复；分类留空向下沿用；报错带文件名与行号。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRICE_SHEETS, type PriceCatalogEntry, type PriceCatalogOverview, type PriceCatalogSet, type PriceImportPreview, type PriceSheet } from '../src/shared/price-catalog';
import { buildWorkbook } from '../src/server/lib/xlsx';
import { readXlsx } from '../src/server/lib/xlsx-read';
import { roomsText } from '../src/server/modules/price-catalog/sheet-io';
import { api, setup, type TestContext } from './helpers';
import { priceSheet, priceWorkbook } from './price-workbook';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

type Preview = PriceImportPreview & { digest: string };
const preview = async (xlsxBase64: string, sheet?: PriceSheet, fileName = sheet ? `${sheet}.xlsx` : '价目表.xlsx') =>
  (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import/preview', { fileName, xlsxBase64, ...(sheet ? { sheet } : {}) })).body as Preview;
async function importFile(xlsxBase64: string, sheet?: PriceSheet): Promise<PriceCatalogSet> {
  const fileName = sheet ? `${sheet}.xlsx` : '价目表.xlsx';
  const p = await preview(xlsxBase64, sheet, fileName);
  expect(
    p.issues.filter((i) => i.level === 'error'),
    JSON.stringify(p.issues),
  ).toEqual([]);
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName, xlsxBase64, ...(sheet ? { sheet } : {}), previewDigest: p.digest, opKey: randomUUID() });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as PriceCatalogSet;
}
const download = async (url: string) => {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie: ctx.owner } });
  expect(res.statusCode, res.body).toBe(200);
  return { buf: res.rawPayload, name: decodeURIComponent(String(res.headers['content-disposition'])) };
};
/** 比较用：去掉行号、排序、编号、版本这些「在哪一份里」的东西 */
const facts = (e: PriceCatalogEntry) => {
  const { sourceRow: _r, sortOrder: _s, ...rest } = e as PriceCatalogEntry & { id?: number; version?: number; setId?: number };
  const { id: _i, version: _v, setId: _set, ...left } = rest as typeof rest & { id?: number; version?: number; setId?: number };
  return left;
};
/** 一张表在用的条目（按内容排序：页面新增的一项排在表尾，导出时归到自己的餐段 / 板块里，先后会变，内容不变） */
const ofSheet = (set: PriceCatalogSet, sheet: PriceSheet) =>
  set.entries
    .filter((e) => e.sheet === sheet && e.active)
    .map(facts)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('价目表各模块单独的模板', () => {
  let full: PriceCatalogSet;

  it('五张表各一个模板：照门店拆出来的表格（第 1 行门店名、表头），导进来 0 项、没有表头错误', async () => {
    for (const sheet of PRICE_SHEETS) {
      const t = await download(`/api/admin/price-catalog/template?sheet=${sheet}`);
      const book = readXlsx(t.buf);
      expect(book.sheets).toHaveLength(1);
      const p = await preview(t.buf.toString('base64'), sheet);
      expect(p.entries).toHaveLength(0);
      expect(p.issues.filter((i) => i.field === '表头' || i.field === '工作表')).toEqual([]);
    }
  });

  it('导出 → 原样再导入：每张表的条目逐项一样，不丢、不重复；别的表照原样', async () => {
    full = await importFile(priceWorkbook());
    // 导入会替换草稿：每次从上一次导出、再导入的那份草稿接着导
    let current = full;
    for (const sheet of PRICE_SHEETS) {
      const out = await download(`/api/admin/price-catalog/sets/${current.id}/export-sheets?sheet=${sheet}`);
      expect(out.name).toContain('.xlsx');
      const again = await importFile(out.buf.toString('base64'), sheet);
      for (const s of PRICE_SHEETS) expect(ofSheet(again, s), `${sheet} → ${s}`).toEqual(ofSheet(full, s));
      expect(again.total.actual).toBe(full.total.actual);
      current = again;
    }
    // 整份按导入格式导出、再整份导入：一样
    const whole = await download(`/api/admin/price-catalog/sets/${current.id}/export-sheets`);
    const back = await importFile(whole.buf.toString('base64'));
    for (const s of PRICE_SHEETS) expect(ofSheet(back, s)).toEqual(ofSheet(full, s));
    expect(back.notes).toEqual(full.notes);
  });

  it('页面上改价、新增一道菜以后导出再导入：改的价、新增的菜都在；只导一张表时别的表上的修改不动', async () => {
    const ov = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview;
    let draft = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${ov.draft!.id}`)).body as PriceCatalogSet & { entries: (PriceCatalogEntry & { id: number; version: number })[] };
    const spa = draft.entries.find((e) => e.name === 'spa房')!;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${spa.id}`, { ...spa, opKey: randomUUID(), priceCents: 42900 })).status).toBe(200);
    const fish = draft.entries.find((e) => e.sheet === 'dish' && e.section === '早餐')!;
    const made = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/sets/${draft.id}/entries`, { ...facts(fish), opKey: randomUUID(), name: '鲜虾云吞', priceCents: 3200, code: '9' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const massage = draft.entries.find((e) => e.name === '古法中式')!;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${massage.id}`, { ...massage, opKey: randomUUID(), price2Cents: 61900 })).status).toBe(200);
    draft = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${draft.id}`)).body;
    let current: PriceCatalogSet = draft;
    for (const sheet of ['room', 'dish'] as const) {
      const out = await download(`/api/admin/price-catalog/sets/${current.id}/export-sheets?sheet=${sheet}`);
      const again = await importFile(out.buf.toString('base64'), sheet);
      current = again;
      for (const s of PRICE_SHEETS) expect(ofSheet(again, s), `${sheet} → ${s}`).toEqual(ofSheet(draft, s));
      expect(again.entries.find((e) => e.name === 'spa房')!.priceCents).toBe(42900);
      expect(again.entries.filter((e) => e.name === '鲜虾云吞')).toHaveLength(1);
      // 按摩表没有重新导，页面上改的资深价还在
      expect(again.entries.find((e) => e.name === '古法中式')!.price2Cents).toBe(61900);
    }
  });

  it('只导一张表：没有草稿时从生效的那份起草，别的表照生效的；条数对照只列这一张', async () => {
    // 先把草稿切换生效
    const ov = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview;
    const act = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { draftId: ov.draft!.id, opKey: randomUUID(), countReason: '用例：合成的表格条数与原表不同' });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    const active = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${ov.draft!.id}`)).body as PriceCatalogSet;
    const ent = priceSheet('娱乐价格', [['汤崎（宝安池里）'], ['类型', '数量', '价格', '备注'], ['台球', 6, '49/2h', '加钟/29.9']]);
    const p = await preview(buildWorkbook([ent]).toString('base64'), 'entertainment');
    expect(p.counts.map((c) => c.sheet)).toEqual(['entertainment']);
    expect(p.total).toEqual({ expected: 8, actual: 1 });
    const draft = await importFile(buildWorkbook([ent]).toString('base64'), 'entertainment');
    expect(draft.status).toBe('draft');
    expect(ofSheet(draft, 'entertainment')).toHaveLength(1);
    expect(ofSheet(draft, 'entertainment')[0]).toMatchObject({ name: '台球', priceCents: 4900, durationMinutes: 120, extraPriceCents: 2990, unitsCount: 6 });
    for (const s of PRICE_SHEETS.filter((x) => x !== 'entertainment')) expect(ofSheet(draft, s)).toEqual(ofSheet(active, s));
    // 生效中的那份没动
    expect(ofSheet((await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${active.id}`)).body, 'entertainment').length).toBeGreaterThan(1);
  });

  it('新格式的读法：类型 / 房型 / 菜品分类只在组首行写（没合并）也认；中餐零点与中式零点统一；工作表改了名也认；报错带文件名、行号、字段', async () => {
    const store = priceSheet('Sheet1', [
      ['汤崎（宝安池里）'],
      ['类型', '项目', '价格', '备注', '时间'],
      ['门票', '12H', 499, '不含餐'],
      [null, '24H', 899, '含3餐'],
      ['餐票', '早餐', 99, '零售', '7:30--10:00'],
      [null, '午餐', 199, null, '11:30--14:00'],
      ['服务费', '服务费', 0.1, '全场消费加10%'],
    ]);
    const s = await preview(buildWorkbook([store]).toString('base64'), 'store', '门店价格.xlsx');
    expect(s.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(s.entries.map((e) => [e.kind, e.name])).toEqual([
      ['ticket', '12H 不含餐'],
      ['ticket', '24H 含餐'],
      ['meal_ticket', '早餐'],
      ['meal_ticket', '午餐'],
      ['service_fee', '服务费'],
    ]);
    expect(s.entries.at(-1)).toMatchObject({ priceMode: 'rate', rateBp: 1000, priceCents: null });
    const rooms = priceSheet('房间价格', [
      ['房型', '总数', '收费参考', null, '备注'],
      ['轰趴房', '2间', '6小时：999\n12小时：1599', null, '70平（H203) 4人位'],
      [null, null, '6小时：899', null, '40平（H210)'],
    ]);
    const r = await preview(buildWorkbook([rooms]).toString('base64'), 'room');
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.variants.map((v) => v.label)).toEqual(['70平 6小时', '70平 12小时', '40平 6小时']);
    const dishes = priceSheet('零点菜品价格', [
      ['午餐自助零点菜品'],
      ['序号', '菜品分类', '菜品名称', '售价', '单位'],
      [1, '中餐零点', '白切鸡', 88, '份'],
      [2, null, '烧鹅', 98, '份'],
      [3, '中式零点', '叉烧', 68, '份'],
    ]);
    const d = await preview(buildWorkbook([dishes]).toString('base64'), 'dish');
    expect(d.entries.map((e) => e.category)).toEqual(['中式零点', '中式零点', '中式零点']);
    // 非法数据：价格带字、缺名称、板块不存在 → 报错，写明文件、行号、字段
    const bad = priceSheet('按摩及助浴价格', [
      ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点'],
      ['康疗', 1, '古法中式', '房间', '80min', '499元起', 599],
      [null, 2, null, '房间', '90min', 599, 699],
      ['美甲', 3, '手部护理', '房间', '30min', 200],
    ]);
    const b = await preview(buildWorkbook([bad]).toString('base64'), 'massage', '按摩及助浴价格.xlsx');
    const errors = b.issues.filter((i) => i.level === 'error').map((i) => [i.file, i.row, i.field]);
    expect(errors).toEqual(
      expect.arrayContaining([
        ['按摩及助浴价格.xlsx', 2, '专业价'],
        ['按摩及助浴价格.xlsx', 3, '项目名称'],
        ['按摩及助浴价格.xlsx', 4, '板块分类'],
      ]),
    );
    const refused = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', {
      fileName: '按摩及助浴价格.xlsx',
      xlsxBase64: buildWorkbook([bad]).toString('base64'),
      sheet: 'massage',
      previewDigest: b.digest,
      opKey: randomUUID(),
    });
    expect(refused.body.error.code).toBe('IMPORT_INVALID');
    // 文件里没有要导的那张表（有好几张、都不是）：报错
    const none = await preview(buildWorkbook([priceSheet('a', [['x']]), priceSheet('b', [['y']])]).toString('base64'), 'room');
    expect(none.issues.some((i) => i.field === '工作表' && i.level === 'error')).toBe(true);
  });

  it('房号清单写回表格：连着的号写成一段', () => {
    expect(roomsText(['S301', 'S302', 'S303', 'Q301', 'Q303', 'R01', 'R02'])).toBe('S301-S303 Q301 Q303 R01-R02');
    expect(roomsText(['V999', 'V888'])).toBe('V999 V888');
    expect(roomsText([])).toBe('');
  });
});
