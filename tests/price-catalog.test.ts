// 价目表录入 第一批（docs/PRICE_CATALOG.md，PC1 起；迁移 230）：六张表导入成草稿——价格字段口径（以分存、带单位的写法拆成
// 价格 / 时长 / 加钟 / 封顶，双价 / 单价 / 无价格三种形态、空值不存 0、服务费按比例）、逐行校验带工作表 / 行号 / 字段 / 原因、
// 条数对照、草稿替换、权限、导入模板。用合成的六张表（照《价目表 1119》的版式与合并格），不放门店的原表。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countMismatches,
  diffPriceCatalogs,
  entryFacts,
  matchesPriceSearch,
  priceCategoriesOf,
  priceCategoryOf,
  priceChangeLines,
  ROOM_SERVICE_EXCLUDED_CATEGORIES,
  priceEntryProblems,
  priceText,
  windowText,
  type PriceCatalogEntry,
  type PriceCatalogOverview,
  type PriceCatalogSet,
  type PriceCategoryCheck,
  type PriceChange,
  type PriceImportPreview,
} from '../src/shared/price-catalog';
import { priceQuote, quoteUnit, serviceFeeOf } from '../src/shared/price-quote';
import type { WbSheet } from '../src/server/lib/xlsx';
import { priceSheet as sheet, priceWorkbook as workbook, type Row } from './price-workbook';
import { readXlsx } from '../src/server/lib/xlsx-read';
import { minutesOf, parsePriceCatalog, roomNumbersOf, windowOf, yuanToCents } from '../src/server/modules/price-catalog/parse';
import { itemCategoryKey, itemCategoryTabs, matchesItemSearch } from '../src/shared/catalog';
import type { Catalog } from '../src/shared/types';
import type { DiningMenu } from '../src/shared/dining';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
/** 用例里按名字取固定的操作编号（服务端要 UUID） */
const OP: Record<string, string> = new Proxy({} as Record<string, string>, { get: (t, k: string) => (t[k] ??= randomUUID()) });
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

const preview = async (xlsxBase64: string, cookie = ctx.owner) => api(ctx.app, cookie, 'POST', '/api/admin/price-catalog/import/preview', { fileName: '汤崎宝安全品类价目表1119.xlsx', xlsxBase64 });
const find = (p: { entries: PriceCatalogEntry[] }, name: string) => p.entries.find((e) => e.name === name)!;

describe('价目表录入 第一批：数据模型与导入', () => {
  it('写法拆字段：元 → 分、时长换算成分钟、时段、房号清单', () => {
    expect(yuanToCents('19.9')).toBe(1990);
    expect(yuanToCents('499')).toBe(49900);
    expect(yuanToCents('0')).toBeNull();
    expect(yuanToCents('399/2H')).toBeNull();
    expect(['80min', '80分钟', "60'", '90’', '2H', '6小时'].map(minutesOf)).toEqual([80, 80, 60, 90, 120, 360]);
    expect(minutesOf('一个半小时')).toBeNull();
    expect(windowOf('7：30--10：00')).toEqual([450, 600]);
    expect(windowOf('23：30--2：00')).toEqual([1410, 120]);
    expect(windowOf(' 21点-次日11点')).toEqual([1260, 660]);
    expect(roomNumbersOf('F301-307')).toEqual(['F301', 'F302', 'F303', 'F304', 'F305', 'F306', 'F307']);
    expect(roomNumbersOf('Q301 Q302')).toEqual(['Q301', 'Q302']);
    expect(roomNumbersOf('R01-R03')).toEqual(['R01', 'R02', 'R03']);
    expect(roomNumbersOf('70平（H203-205) 4人位')).toEqual(['H203', 'H204', 'H205']);
  });

  it('预览：六张表逐项读成条目，价格字段口径照需求说明（双价 / 单价 / 无价格、服务费比例、空值不存 0）', async () => {
    const res = await preview(workbook());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body as PriceImportPreview;
    expect(p.errorCount, JSON.stringify(p.issues)).toBe(0);
    // 门店：门票按「时长 × 是否含餐」4 项，夜间票带时段，餐票带供应时段；服务费按比例、不算条数
    expect(find(p, '12H 不含餐')).toMatchObject({ kind: 'ticket', priceMode: 'single', priceCents: 49900, durationMinutes: 720, includesMeal: false });
    expect(find(p, '24H 含餐')).toMatchObject({ priceCents: 89900, durationMinutes: 1440, includesMeal: true });
    expect(find(p, '夜间票')).toMatchObject({ kind: 'night_ticket', priceCents: 59900, windowStart: 1260, windowEnd: 660 });
    expect(find(p, '早餐')).toMatchObject({ kind: 'meal_ticket', priceCents: 9900, windowStart: 450, windowEnd: 600 });
    expect(find(p, '夜宵')).toMatchObject({ windowStart: 1410, windowEnd: 120 });
    expect(find(p, '服务费')).toMatchObject({ kind: 'service_fee', priceMode: 'rate', rateBp: 1000, priceCents: null });
    // 娱乐：基础价（含 2 小时）与加钟价分开；台位数；畅玩卷单次、不设时长
    expect(find(p, '台球')).toMatchObject({ priceCents: 3900, durationMinutes: 120, extraPriceCents: 1990, extraMinutes: 60, unitsCount: 4 });
    expect(find(p, '斯诺克')).toMatchObject({ priceCents: 9900, extraPriceCents: 5990 });
    expect(find(p, '畅玩卷')).toMatchObject({ kind: 'play_pass', priceCents: 9900, durationMinutes: null, extraPriceCents: null });
    // 房间：起开价含时长、超时单价、封顶价、房号清单；轰趴房按面积分档；餐饮包房位价与低消
    const spa = find(p, 'spa房');
    expect(spa).toMatchObject({ kind: 'room_type', priceCents: 39900, durationMinutes: 120, extraPriceCents: 19900, extraMinutes: 60, capCents: 99900, unitsCount: 35 });
    expect(spa.roomNumbers).toHaveLength(35);
    expect(find(p, '棋牌房').variants).toEqual([{ label: '8小时', minutes: 480, priceCents: 69900, unit: '' }]);
    expect(find(p, '客房').variants.map((v) => [v.label, v.priceCents, v.minutes])).toEqual([
      ['小房间 过夜', 59900, null],
      ['大房间 过夜', 69900, null],
      ['小房间 3小时', 39900, 180],
      ['大房间 3小时', 49900, 180],
    ]);
    const party = find(p, '轰趴房');
    expect(party.kind).toBe('party_room');
    expect(party.variants.filter((v) => v.label.startsWith('70平')).map((v) => [v.label, v.priceCents, v.roomNumbers?.length, v.seats])).toEqual([
      ['70平 6小时', 99900, 7, 4],
      ['70平 12小时', 159900, 7, 4],
    ]);
    expect(party.variants.find((v) => v.label === '150平 包天')?.priceCents).toBe(600000);
    const dining = find(p, '餐饮包房');
    expect(dining).toMatchObject({ kind: 'dining_room', unit: '位', extraPriceCents: 58800 });
    expect(dining.roomNumbers).toEqual(['V999', 'V888', 'V777', 'V666', 'V555']);
    expect(dining.variants.map((v) => v.priceCents)).toEqual([68800, 98800, 128800, 688800]);
    // 零点菜品：餐段 → 分类 → 菜品；2 楼零点没有售价的是「待定价」、不能下单（价格是空值，不是 0）
    const abalone = p.entries.filter((e) => e.name === '蚝皇扣鲍鱼');
    expect(abalone.map((e) => [e.section, e.priceMode, e.priceCents, e.orderable])).toEqual([
      ['2楼零点', 'none', null, false],
      ['晚餐', 'single', 23800, true],
    ]);
    expect(find(p, '皮蛋瘦肉粥')).toMatchObject({ section: '早餐', category: '生滚粥', unit: '份', priceCents: 3800 });
    // 按摩：双价、单价；时长统一分钟；「资深价」一列写的是性别的进「适用性别」；「—」是没有资深价；编号保留
    expect(find(p, '古法中式')).toMatchObject({ section: '康疗', code: '1', priceMode: 'dual', priceCents: 49900, price2Cents: 59900, durationMinutes: 80, venues: ['room'] });
    expect(find(p, '瑜伽泰式').section).toBe('康疗');
    expect(find(p, '十二经络疏通调理')).toMatchObject({ priceMode: 'single', priceCents: 70000, price2Cents: null });
    expect(find(p, '伊索抗衰面部护理').durationMinutes).toBe(80);
    expect(find(p, '海蓝之谜清洁面部护理').durationMinutes).toBe(60);
    expect(find(p, '精致修脚')).toMatchObject({ priceMode: 'single', venues: ['room', 'lobby'] });
    expect(find(p, '茱莉蔻柑橘护理')).toMatchObject({ priceMode: 'single', priceCents: 40000, gender: 'any', venues: ['bath'] });
    expect(find(p, '茱莉蔻玫瑰柔肤护理').gender).toBe('female');
    expect(find(p, '泰式私汤药浴(女宾)').gender).toBe('female');
    expect(find(p, '手部美甲精修')).toMatchObject({ section: '护理', code: '74', durationMinutes: null, venues: [] });
    // 不录内部参考字段（核心定位、思路）；储值政策只记那一句
    expect(JSON.stringify(find(p, '古法中式'))).not.toContain('内部');
    expect(p.notes).toEqual({ 储值政策: '同步大客部门 建议两店通用' });
    // 条数对照：门店 9（服务费不算）、娱乐 8、房间 9；表里自相矛盾的（12 小时价比 6 小时低）只提醒
    expect(p.counts.map((c) => [c.name, c.actual])).toEqual([
      ['门店价格', 9],
      ['娱乐价格', 8],
      ['房间价格', 9],
      ['零点菜品价格', 6],
      ['按摩及助浴价格', 10],
    ]);
    expect(
      p.issues
        .filter((i) => i.level === 'warning')
        .map((i) => i.message)
        .join('|'),
    ).toContain('12 小时价（2000）比 6 小时价（2399）还低');
    expect(p.issues.find((i) => i.message.includes('蚝皇扣鲍鱼'))).toMatchObject({ sheet: '零点菜品价格', row: 3, field: '售价', level: 'warning' });
  });

  it('逐行校验：报错写明工作表、行号、字段与原因（价格为空、时长格式不支持、名称重复、板块不存在、少了工作表）', async () => {
    const bad = workbook({
      按摩及助浴价格: sheet('按摩及助浴价格', [
        ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点'],
        ['康疗', 1, '古法中式', '房间', '一个半小时', 499, 599],
        [null, 2, '古法中式', '房间', '80min', 499, 599],
        ['足疗', 3, '足部', '房间', '60min', 300, null],
        ['SPA', 5, '瑞典舒压', '房间', '70min', null, null],
      ]),
      娱乐价格: sheet('不是娱乐', [['x']]),
    });
    const res = await preview(bad);
    const p = res.body as PriceImportPreview;
    const errors = p.issues.filter((i) => i.level === 'error').map((i) => `${i.sheet}|${i.row ?? ''}|${i.field}|${i.message}`);
    expect(errors).toEqual(
      expect.arrayContaining([
        "按摩及助浴价格|2|时长|时长格式不支持：「一个半小时」（写 60min、60分钟、60'，在 1 到 2880 分钟之间）",
        expect.stringMatching(/^按摩及助浴价格\|3\|项目名称\|名称重复：「古法中式」在「康疗」第 2 行已经有了/),
        expect.stringMatching(/^按摩及助浴价格\|4\|板块分类\|板块「足疗」不存在/),
        '按摩及助浴价格|5|专业价|价格为空',
        '娱乐价格||工作表|少了「娱乐价格」这张表',
      ]),
    );
    expect(p.errorCount).toBe(errors.length);
    // 有问题整份不导
    const refused = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', {
      fileName: 'x.xlsx',
      xlsxBase64: bad,
      previewDigest: 'a'.repeat(64),
      opKey: randomUUID(),
    });
    expect(refused.status).toBe(422);
  });

  it('导入成草稿：条目落库、条数对照；再导一份替换原来的草稿；生效的价目表不受影响；只有能管理项目的能导', async () => {
    const file = workbook();
    const p = (await preview(file)).body as PriceImportPreview & { digest: string };
    // 换了文件（摘要对不上）不导
    expect(
      (
        await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', {
          fileName: 'a.xlsx',
          xlsxBase64: file,
          previewDigest: 'b'.repeat(64),
          opKey: randomUUID(),
        })
      ).body.error.code,
    ).toBe('IMPORT_STALE');
    const done = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', {
      fileName: '汤崎宝安全品类价目表1119.xlsx',
      xlsxBase64: file,
      previewDigest: p.digest,
      opKey: randomUUID(),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const set = done.body as PriceCatalogSet;
    expect(set.status).toBe('draft');
    expect(set.entries).toHaveLength(p.entries.length);
    expect(set.total.actual).toBe(42);
    expect(set.notes).toEqual({ 储值政策: '同步大客部门 建议两店通用' });
    const stored = set.entries.find((e) => e.name === '古法中式')!;
    expect(stored).toMatchObject({ priceMode: 'dual', priceCents: 49900, price2Cents: 59900, durationMinutes: 80, venues: ['room'], audience: '久坐办公' });
    expect(set.entries.find((e) => e.name === '服务费')).toMatchObject({ priceMode: 'rate', rateBp: 1000, priceCents: null });
    // 数据库里空价存的是空值，不是 0
    const [zero] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM price_catalog_entries WHERE set_id = ${set.id} AND (price_cents = 0 OR price2_cents = 0)`;
    expect(zero!.n).toBe(0);
    const [noneRow] = await ctx.sql<{ none: number }[]>`SELECT count(*)::int AS none FROM price_catalog_entries WHERE set_id = ${set.id} AND price_mode = 'none' AND price_cents IS NULL`;
    expect(noneRow!.none).toBe(2);
    const overview = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview;
    expect(overview.active).toBeNull();
    expect(overview.draft).toMatchObject({ id: set.id, status: 'draft', total: { expected: 224, actual: 42 } });
    // 再导一份：替换原来的草稿（一家门店只有一份草稿）
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', {
      fileName: '第二版.xlsx',
      xlsxBase64: file,
      previewDigest: p.digest,
      title: '第二版',
      opKey: randomUUID(),
    });
    expect(again.status).toBe(201);
    const [draftRow] = await ctx.sql<{ drafts: number }[]>`SELECT count(*)::int AS drafts FROM price_catalog_sets WHERE status = 'draft'`;
    expect(draftRow!.drafts).toBe(1);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${set.id}`)).status).toBe(404);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${again.body.id}`)).body.title).toBe('第二版');
    // 留审计
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'price_catalog'`;
    expect(audit!.n).toBe(2);
    // 前台店员没有「管理充值套餐与消费项目」
    expect((await preview(file, ctx.clerk)).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/price-catalog')).status).toBe(403);
  });

  it('导入模板：与《价目表 1119》同结构的六张表', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/price-catalog/template', headers: { cookie: ctx.owner } });
    expect(res.statusCode).toBe(200);
    expect(decodeURIComponent(String(res.headers['content-disposition']))).toContain('价目表导入模板.xlsx');
    const book = readXlsx(res.rawPayload);
    expect(book.sheets.map((s) => s.name)).toEqual(['门店价格', '娱乐价格', '房间价格', '零点菜品价格', '按摩及助浴价格', '储值政策']);
    const line = (i: number, r: number) => [...(book.sheets[i]!.rows.get(r)?.values() ?? [])].map((c) => c.value).filter((v) => v !== '');
    expect(line(4, 1)).toEqual(['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点']);
    // 空模板原样导回去：没有条目、每张表都在（没有「少了工作表」）
    const p = (await preview(res.rawPayload.toString('base64'))).body as PriceImportPreview;
    expect(p.issues.filter((i) => i.field === '工作表')).toEqual([]);
    expect(p.total.actual).toBe(0);
  });

  it('第二批 列表与搜索：价格写法（待定价不写 0 元）、规格一行、搜索名称 / 编号 / 房号、草稿与生效对比', async () => {
    const p = (await preview(workbook())).body as PriceImportPreview;
    const yuan = (c: number) => `¥${c / 100}`;
    expect(priceText(find(p, '古法中式'), yuan)).toBe('专业 ¥499 / 资深 ¥599');
    expect(priceText(find(p, '十二经络疏通调理'), yuan)).toBe('¥700');
    expect(priceText(p.entries.find((e) => e.name === '沙姜炒鸡')!, yuan)).toBe('待定价');
    expect(priceText(find(p, '服务费'), yuan)).toBe('10%');
    expect(entryFacts(find(p, 'spa房'), yuan)).toEqual(['含 2 小时', '超时 ¥199/1 小时', '封顶 ¥999', '35 间', 'S301–S335（35 个）']);
    expect(entryFacts(find(p, '台球'), yuan)).toEqual(['含 2 小时', '加钟 ¥19.9/1 小时', '4 台']);
    expect(entryFacts(find(p, '24H 含餐'), yuan)).toEqual(['24 小时 · 含餐']);
    expect(entryFacts(find(p, '茱莉蔻柑橘护理'), yuan)).toEqual(['45 分钟', '浴区', '适用 男 / 女']);
    expect(windowText(1410, 120)).toBe('23:30–次日2:00');
    expect(p.entries.filter((e) => matchesPriceSearch(e, 's303')).map((e) => e.name)).toEqual(['spa房']);
    expect(p.entries.filter((e) => matchesPriceSearch(e, '74')).map((e) => e.name)).toEqual(['手部美甲精修']);
    expect(p.entries.filter((e) => matchesPriceSearch(e, '生滚')).map((e) => e.name)).toEqual(['生滚牛肉粥', '皮蛋瘦肉粥']);
    // 对比：改价、新增、少了；同名不同餐段的算两项
    const active = p.entries;
    const draft = p.entries
      .filter((e) => e.name !== '台球')
      .map((e) => (e.name === '古法中式' ? { ...e, priceCents: 52900 } : e))
      .concat({ ...find(p, '斯诺克'), name: '新球桌' });
    const diff = diffPriceCatalogs(draft, active).map((d) => [d.change, (d.draft ?? d.active)!.name]);
    expect(diff).toEqual([
      ['changed', '古法中式'],
      ['added', '新球桌'],
      ['removed', '台球'],
    ]);
    expect(diffPriceCatalogs(active, active)).toEqual([]);
  });
});

describe('价目表录入 第三批：编辑与校验', () => {
  const yuan = (c: number) => `¥${c / 100}`;
  const importDraft = async (title: string) => {
    const file = workbook();
    const p = (await preview(file)).body as PriceImportPreview & { digest: string };
    const res = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', {
      fileName: `${title}.xlsx`,
      xlsxBase64: file,
      previewDigest: p.digest,
      title,
      opKey: randomUUID(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as PriceCatalogSet;
  };
  const overview = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview;
  const put = (e: PriceCatalogEntry, patch: Partial<PriceCatalogEntry> & { reason?: string }, cookie = ctx.owner) =>
    api(ctx.app, cookie, 'POST', `/api/admin/price-catalog/entries/${e.id}`, { ...e, opKey: randomUUID(), ...patch });
  const changes = async (setId: number, q = '') => (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${setId}/changes${q}`)).body as PriceChange[];

  it('校验（页面与服务端同一份）：价格形态与价格一致、金额大于 0、待定价不填 0、待定价的菜不能下单、板块 / 餐段认得', async () => {
    const p = (await preview(workbook())).body as PriceImportPreview;
    const massage = find(p, '古法中式');
    expect(priceEntryProblems(massage)).toEqual([]);
    expect(priceEntryProblems({ ...massage, priceMode: 'single', price2Cents: 59900 })).toContain('单价只填一个价');
    expect(priceEntryProblems({ ...massage, priceCents: 0 })).toContain('专业价要大于 0、不超过 100 万元');
    expect(priceEntryProblems({ ...massage, priceMode: 'none' })).toContain('待定价不填价格（空着，不写 0）');
    expect(priceEntryProblems({ ...massage, section: '足疗' })[0]).toMatch(/^板块不存在/);
    expect(priceEntryProblems({ ...massage, priceMode: 'rate', priceCents: null, price2Cents: null, rateBp: 1000 })).toContain('只有服务费按比例填');
    const dish = p.entries.find((e) => e.name === '沙姜炒鸡')!;
    expect(priceEntryProblems({ ...dish, orderable: true })).toContain('待定价的菜不能下单：先填售价，再设为可下单');
    expect(priceEntryProblems({ ...dish, section: '宵夜' })[0]).toMatch(/^餐段不认识/);
    expect(priceEntryProblems({ ...find(p, '台球'), extraPriceCents: null })).toContain('填了每次多少分钟，也要填加钟 / 超时价');
    expect(countMismatches([{ sheet: 'massage', name: '按摩及助浴价格', expected: 67, actual: 66, parts: [{ name: '康疗', expected: 4, actual: 3 }] }])).toEqual([
      '按摩及助浴价格：系统 66 / 表格 67',
      '按摩及助浴价格 · 康疗：系统 3 / 表格 4',
    ]);
  });

  it('改价留痕、版本号、名称重复、单条新增、停用 / 启用；切换生效（条数对不上要写原因）、改旧版被拒、整体回滚、放弃草稿', async () => {
    const draft = await importDraft('第三批草稿');
    const gufa = draft.entries.find((e) => e.name === '古法中式')!;
    expect(gufa.version).toBe(1);

    // 改价：旧价 → 新价，记经办人、时间、原因；版本号加一
    const r1 = await put(gufa, { priceCents: 52900, price2Cents: 62900, reason: '11 月调价' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ priceCents: 52900, price2Cents: 62900, version: 2 });
    const [c1] = await changes(draft.id);
    expect(c1).toMatchObject({ action: 'update', entryName: '古法中式', priceChanged: true, reason: '11 月调价', staffName: expect.any(String) });
    expect(priceChangeLines(c1!.before, c1!.after, yuan)).toEqual([{ label: '价格', from: '专业 ¥499 / 资深 ¥599', to: '专业 ¥529 / 资深 ¥629' }]);
    // 拿着旧版本号再改：别人先改过了，拒绝，不悄悄覆盖
    const stale = await put(gufa, { priceCents: 50000 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PRICE_VERSION');
    // 什么都没改：不留痕、版本不变
    const same = await put(r1.body as PriceCatalogEntry, {});
    expect(same.body.version).toBe(2);
    expect(await changes(draft.id)).toHaveLength(1);
    // 只改备注：留痕但不算改价
    await put(r1.body as PriceCatalogEntry, { note: '含热石' });
    expect((await changes(draft.id))[0]).toMatchObject({ priceChanged: false });
    expect(await changes(draft.id, '?priceOnly=1')).toHaveLength(1);

    // 校验在服务端也挡：空价存 0、待定价的菜下单
    const zero = await put((await changes(draft.id))[0]!.after, { priceCents: 0 });
    expect(zero.status).toBe(422);
    expect(zero.body.error.code).toBe('PRICE_INVALID');
    const dish = draft.entries.find((e) => e.name === '沙姜炒鸡')!;
    expect((await put(dish, { orderable: true })).body.error.message).toContain('待定价的菜不能下单');
    // 补价后启用：待定价 → 单价、可下单
    const priced = await put(dish, { priceMode: 'single', priceCents: 6800, orderable: true, reason: '补价' });
    expect(priced.body).toMatchObject({ priceMode: 'single', priceCents: 6800, orderable: true });
    const [c2] = await changes(draft.id);
    expect(priceChangeLines(c2!.before, c2!.after, yuan)).toEqual([
      { label: '价格', from: '待定价', to: '¥68' },
      { label: '能否下单', from: '不可下单', to: '可下单' },
    ]);

    // 单条新增：同一个板块里同名的（不分大小写、不管空格）拒绝；新的排在这张表最后
    const base = {
      sheet: 'massage',
      kind: 'massage',
      section: '康疗',
      category: '',
      code: '77',
      unit: '',
      priceMode: 'single',
      priceCents: 19900,
      durationMinutes: 30,
      venues: ['lobby'],
      orderable: true,
    };
    const dup = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/sets/${draft.id}/entries`, { opKey: randomUUID(), ...base, name: '古法 中式' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PRICE_NAME_DUPLICATE');
    // 服务费不能新增；板块不存在挡下
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/sets/${draft.id}/entries`, { opKey: randomUUID(), ...base, kind: 'service_fee', name: '服务费2' })).status).toBe(422);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/sets/${draft.id}/entries`, { opKey: randomUUID(), ...base, section: '足疗', name: '足底' })).body.error.code).toBe(
      'PRICE_INVALID',
    );
    const created = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/sets/${draft.id}/entries`, { opKey: randomUUID(), ...base, name: '肩颈放松', reason: '新项目' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const neu = created.body as PriceCatalogEntry;
    expect(neu).toMatchObject({ name: '肩颈放松', priceMode: 'single', priceCents: 19900, price2Cents: null, version: 1, active: true, sourceRow: null });
    expect((await changes(draft.id))[0]).toMatchObject({ action: 'create', before: null, priceChanged: true });
    const afterCreate = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${draft.id}`)).body as PriceCatalogSet;
    expect(afterCreate.entries.filter((e) => e.sheet === 'massage').at(-1)!.name).toBe('肩颈放松');
    expect(afterCreate.total.actual).toBe(draft.total.actual + 1);

    // 停用不删除；停用的不算条数；同名的可以另建，但旧的就不能再启用
    const off = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${neu.id}/active`, { opKey: randomUUID(), version: 1, active: false, reason: '暂不做' });
    expect(off.body).toMatchObject({ active: false, version: 2 });
    expect((await changes(draft.id))[0]).toMatchObject({ action: 'deactivate', reason: '暂不做', priceChanged: false });
    expect((await overview()).draft!.total.actual).toBe(draft.total.actual);
    const again = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/sets/${draft.id}/entries`, { opKey: randomUUID(), ...base, name: '肩颈放松' });
    expect(again.status).toBe(201);
    const on = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${neu.id}/active`, { opKey: randomUUID(), version: 2, active: true });
    expect(on.body.error.code).toBe('PRICE_NAME_DUPLICATE');
    await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${again.body.id}/active`, { opKey: randomUUID(), version: 1, active: false });
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${neu.id}/active`, { opKey: randomUUID(), version: 2, active: true })).body).toMatchObject({
      active: true,
      version: 3,
    });

    // 店员不能改
    expect((await put(neu, { priceCents: 100 }, ctx.clerk)).status).toBe(403);

    // 切换生效：条数与表格（224）对不上，要写原因
    const short = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { opKey: randomUUID(), draftId: draft.id });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('PRICE_COUNT_MISMATCH');
    expect(short.body.error.message).toContain('按摩及助浴价格');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { opKey: randomUUID(), draftId: draft.id + 999, countReason: '演练' })).body.error.code).toBe(
      'PRICE_SET_CHANGED',
    );
    const on1 = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { opKey: randomUUID(), draftId: draft.id, countReason: '合成的演练表，只有一部分' });
    expect(on1.status, JSON.stringify(on1.body)).toBe(200);
    expect(on1.body).toMatchObject({ active: { id: draft.id, status: 'active' }, draft: null, previous: null });
    // 生效中的也能改（马上作数），留痕照记
    const live = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${draft.id}`)).body as PriceCatalogSet;
    const ball = live.entries.find((e) => e.name === '台球')!;
    expect((await put(ball, { extraPriceCents: 2990, reason: '加钟调价' })).body).toMatchObject({ extraPriceCents: 2990 });
    const [c3] = await changes(draft.id);
    expect(priceChangeLines(c3!.before, c3!.after, yuan)).toEqual([{ label: '加钟', from: '¥19.9/1 小时', to: '¥29.9/1 小时' }]);

    // 再导一份、切换：原来生效的转停用，成为「上一版」；旧版不能再改
    const second = await importDraft('第二份');
    const on2 = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { opKey: randomUUID(), draftId: second.id, countReason: '演练' })).body as PriceCatalogOverview;
    expect(on2.active!.id).toBe(second.id);
    expect(on2.previous).toMatchObject({ id: draft.id, status: 'retired', retiredAt: expect.any(String) });
    const retired = await put(ball, { version: 2, priceCents: 4900 } as Partial<PriceCatalogEntry>);
    expect(retired.status).toBe(422);
    expect(retired.body.error.code).toBe('PRICE_SET_RETIRED');

    // 整体回滚：要写原因；拿错了生效的那份不回滚；回滚后上一版生效、刚才那份成为上一版
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/rollback', { activeId: second.id, reason: '', opKey: OP['rollback-op-0000'] })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/rollback', { activeId: draft.id, reason: '演练回滚', opKey: OP['rollback-op-0001'] })).body.error.code).toBe(
      'PRICE_SET_CHANGED',
    );
    const back = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/rollback', { activeId: second.id, reason: '演练回滚', opKey: OP['rollback-op-0002'] })).body as PriceCatalogOverview;
    // 回滚的响应丢了、之后别人又回滚回去：原样重提第一次的请求什么都不改，不把生效的再切回去
    const undo = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/rollback', { activeId: draft.id, reason: '再回去', opKey: OP['rollback-op-0003'] })).body as PriceCatalogOverview;
    expect(undo.active!.id).toBe(second.id);
    const replay = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/rollback', { activeId: second.id, reason: '演练回滚', opKey: OP['rollback-op-0002'] }))
      .body as PriceCatalogOverview;
    expect(replay.active!.id).toBe(second.id);
    const redo = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/rollback', { activeId: second.id, reason: '演练回滚', opKey: OP['rollback-op-0004'] })).body as PriceCatalogOverview;
    expect(redo.active!.id).toBe(draft.id);
    expect(back.active).toMatchObject({ id: draft.id, status: 'active', retiredAt: null });
    expect(back.previous).toMatchObject({ id: second.id, status: 'retired' });
    // 回滚回来的那份里，之前的改价都在
    const restored = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${draft.id}`)).body as PriceCatalogSet;
    expect(restored.entries.find((e) => e.name === '古法中式')).toMatchObject({ priceCents: 52900, price2Cents: 62900 });
    const [activeRow] = await ctx.sql<{ actives: number }[]>`SELECT count(*)::int AS actives FROM price_catalog_sets WHERE status = 'active'`;
    expect(activeRow!.actives).toBe(1);

    // 放弃草稿：连同条目、留痕一起删
    const third = await importDraft('不要了');
    const thirdEntry = third.entries[0]!;
    await put(thirdEntry, { note: '试改' });
    const gone = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/discard', { opKey: randomUUID(), draftId: third.id })).body as PriceCatalogOverview;
    expect(gone.draft).toBeNull();
    const [leftRow] = await ctx.sql<{ left: number }[]>`SELECT count(*)::int AS left FROM price_catalog_changes WHERE set_id = ${third.id}`;
    expect(leftRow!.left).toBe(0);

    // 留痕只追加：不许改
    await expect(ctx.sql`UPDATE price_catalog_changes SET reason = 'x'`).rejects.toThrow();
    // 审计：改价、新增、停用、切换、回滚、放弃都有
    const labels = (await ctx.sql<{ label: string }[]>`SELECT detail->>'label' AS label FROM audit_logs WHERE action = 'price_catalog' ORDER BY id`).map((r) => r.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        '草稿修改「古法中式」（改价）',
        '草稿新增「肩颈放松」',
        '草稿停用「肩颈放松」',
        '生效中的价目表修改「台球」（改价）',
        expect.stringMatching(/^切换生效「第三批草稿」/),
        '整体回滚到「第三批草稿」（换下「第二份」）',
        '放弃草稿「不要了」',
      ]),
    );
  });
});

describe('价目表录入 审查修正（PR #160）', () => {
  const issuesOf = async (over: Partial<Record<string, WbSheet>>) => ((await preview(workbook(over))).body as PriceImportPreview).issues;
  const ent = (rows: Row[]) => sheet('娱乐价格', [['汤崎'], ['类型', '数量', '价格', '备注'], ...rows]);

  it('导入带操作编号：原样重提返回第一次的草稿；草稿被替换后再重提拒绝；同一编号换文件拒绝；两次导入同时来只留一份草稿', async () => {
    const file = workbook();
    const p = (await preview(file)).body as PriceImportPreview & { digest: string };
    const body = { fileName: '重提.xlsx', xlsxBase64: file, previewDigest: p.digest, opKey: OP['retry-op-0001'] };
    const first = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', body);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    // 缺编号不导
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { ...body, opKey: undefined })).status).toBe(400);
    // 同一个编号换了文件
    const other = workbook({ 娱乐价格: ent([['台球', 4, '49/2h', '加钟/19.9']]) });
    const p2 = (await preview(other)).body as PriceImportPreview & { digest: string };
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { ...body, xlsxBase64: other, previewDigest: p2.digest })).body.error.code).toBe('IMPORT_OP_REUSED');
    // 别人导了新草稿以后，旧请求的重提不覆盖它
    const newer = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { ...body, opKey: OP['retry-op-0002'] });
    expect(newer.status).toBe(201);
    const late = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', body);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('IMPORT_DONE');
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview).draft!.id).toBe(newer.body.id);
    // 两次导入同时来：门店级的锁排队，都成功、最后只有一份草稿（不撞唯一索引报 500）
    const both = await Promise.all([OP['race-op-0001'], OP['race-op-0002']].map((opKey) => api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { ...body, opKey })));
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    const [draftRow] = await ctx.sql<{ drafts: number }[]>`SELECT count(*)::int AS drafts FROM price_catalog_sets WHERE status = 'draft'`;
    expect(draftRow!.drafts).toBe(1);
  });

  it('文件与写法：合并区域过大整份拒绝；加钟价多出来的位数、时长超范围、菜品表头写错、房号过多都报错', async () => {
    const huge = sheet('储值政策', [['储值政策']], ['A1:Z5000']);
    const res = await preview(workbook({ 储值政策: huge }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IMPORT_FILE_INVALID');

    expect((await issuesOf({ 娱乐价格: ent([['台球', 4, '39/2h', '加钟/19.999']]) })).find((i) => i.level === 'error')).toMatchObject({ sheet: '娱乐价格', row: 3, field: '备注' });

    const massage = (dur: string) =>
      sheet('按摩及助浴价格', [
        ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点'],
        ['康疗', 1, '古法中式', '房间', dur, 499, 599],
      ]);
    for (const dur of ['0min', '3000min']) {
      expect((await issuesOf({ 按摩及助浴价格: massage(dur) })).find((i) => i.level === 'error')).toMatchObject({ row: 2, field: '时长' });
    }

    const dishes = (head: Row) => sheet('零点菜品价格', [['早餐自助零点菜品'], head, [1, '生滚粥', '生滚牛肉粥', 38, '份']], ['A1:E1']);
    const misspelled = (await issuesOf({ 零点菜品价格: dishes(['序号', '菜品分类', '菜品名', '售价', '单位']) })).filter((i) => i.level === 'error');
    expect(misspelled[0]).toMatchObject({ sheet: '零点菜品价格', row: 2, field: '表头' });
    expect(misspelled[0]!.message).toContain('菜品名称');
    const noPrice = (await issuesOf({ 零点菜品价格: dishes(['序号', '菜品分类', '菜品名称', '单位']) })).filter((i) => i.level === 'error');
    expect(noPrice[0]!.message).toContain('售价');

    const rooms = sheet('房间价格', [
      ['房型', '总数', '收费参考', null, '备注'],
      ['spa房', '35间', '399/2H起开', '超时199/H\n999封顶过夜', 'S100-S299 T100-T299'],
    ]);
    expect((await issuesOf({ 房间价格: rooms })).find((i) => i.level === 'error')!.message).toContain('房号太多');
    expect(roomNumbersOf('S301-S303 S302 s301')).toEqual(['S301', 'S302', 'S303']);
  });

  it('草稿与生效对比：只改了分档价格（客房大房间、轰趴房非最低档）也算改价', async () => {
    const p = (await preview(workbook())).body as PriceImportPreview;
    const guest = find(p, '客房');
    const changed = p.entries.map((e) => (e.name === '客房' ? { ...e, variants: e.variants.map((v, i) => (i === 1 ? { ...v, priceCents: 79900 } : v)) } : e));
    expect(guest.variants.length).toBeGreaterThan(1);
    expect(diffPriceCatalogs(changed, p.entries).map((d) => [d.change, d.draft?.name])).toEqual([['changed', '客房']]);
  });

  it('第二轮审查：导入查重与编辑同一个键、时段的分钟要合法、表格行数上限、改分档价主价格跟着变', async () => {
    const dishes = sheet(
      '零点菜品价格',
      [['早餐自助零点菜品'], ['序号', '菜品分类', '菜品名称', '售价', '单位'], [1, '生滚粥', '牛肉粥', 38, '份'], [2, null, '牛 肉粥', 48, '份']],
      ['A1:E1', 'B3:B4'],
    );
    expect((await issuesOf({ 零点菜品价格: dishes })).find((i) => i.level === 'error')).toMatchObject({ row: 4, field: '菜品名称' });

    expect(windowOf('7:99--10:00')).toBeNull();
    expect(windowOf('24:00--2:00')).toBeNull();
    expect(windowOf('23：30--2：00')).toEqual([1410, 120]);

    const many = sheet('娱乐价格', [['类型', '数量', '价格', '备注'], ...Array.from({ length: 2100 }, (_, i): Row => [`台${i}`, 1, 39, null])]);
    const tooMany = await preview(workbook({ 娱乐价格: many }));
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe('IMPORT_FILE_INVALID');

    // 改客房小房间的过夜价：主价格（过夜价里最低的）跟着变
    const draft = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${((await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview).draft!.id}`))
      .body as PriceCatalogSet;
    const guest = draft.entries.find((e) => e.name === '客房')!;
    expect(guest.priceCents).toBe(59900);
    const variants = guest.variants.map((v) => (v.unit === '晚' && v.priceCents === 59900 ? { ...v, priceCents: 79900 } : v));
    const saved = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${guest.id}`, { ...guest, variants, opKey: randomUUID() });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.priceCents).toBe(69900);
  });

  it('第三轮审查：导入、回滚接上「结果待确认」（查回、确认作废后原请求不再生效）；娱乐价格时长不合法报错；轰趴房合并行过多整份拒绝', async () => {
    const file = workbook();
    const p = (await preview(file)).body as PriceImportPreview & { digest: string };
    const body = { fileName: '作废.xlsx', xlsxBase64: file, previewDigest: p.digest, opKey: randomUUID() };
    // 查回：没导过的查不到；确认作废以后，原请求晚到也不导
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${body.opKey}?type=price_import`)).body).toMatchObject({ found: false, abandoned: false });
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${body.opKey}/abandon`, { type: 'price_import', summary: '演练' })).body).toMatchObject({ found: false, abandoned: true });
    const late = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', body);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    // 导过的查回能找到那份草稿
    const ok = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { ...body, opKey: randomUUID() });
    expect(ok.status).toBe(201);
    const [okOp] = await ctx.sql<{ opKey: string }[]>`SELECT op_key FROM price_catalog_import_ops WHERE set_id = ${ok.body.id}`;
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${okOp!.opKey}?type=price_import`)).body).toMatchObject({ found: true, refId: ok.body.id });
    // 回滚作废后原请求不生效；店员不能查回
    const rb = randomUUID();
    await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${rb}/abandon`, { type: 'price_rollback' });
    const ov = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview;
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/rollback', { activeId: ov.active!.id, reason: '演练', opKey: rb });
    expect(r.body.error.code).toBe('OP_ABANDONED');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${rb}?type=price_rollback`)).status).toBe(403);

    for (const bad of ['39/0min', '39/3000min']) {
      const issues = (await issuesOf({ 娱乐价格: ent([['台球', 4, bad, '加钟/19.9']]) })).filter((i) => i.level === 'error');
      expect(issues[0]).toMatchObject({ row: 3, field: '价格' });
    }

    const party = sheet(
      '房间价格',
      [
        ['房型', '总数', '收费参考', null, '备注'],
        ...Array.from({ length: 30 }, (_, i): Row => [i === 0 ? '轰趴房' : null, i === 0 ? '9间' : null, '6小时：999', null, `${i + 40}平（H2${String(i).padStart(2, '0')})`]),
      ],
      ['A2:A31', 'B2:B31'],
    );
    const tooMany = await preview(workbook({ 房间价格: party }));
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe('IMPORT_FILE_INVALID');
  });

  it('第四轮审查：房间价格多写了小数位整段报错（不截出其中一段）；基础价含的时长改了也算改价', async () => {
    const rooms = (price: string, rule: string | null, type = '客房') =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        [type, '7间', price, rule, 'R01-R07'],
      ]);
    const guest = (await issuesOf({ 房间价格: rooms('小房间 599.999/晚\n大房间 699/晚', '399/3小时') })).filter((i) => i.level === 'error');
    expect(guest[0]).toMatchObject({ sheet: '房间价格', row: 2, field: '收费参考' });
    expect(guest[0]!.message).toContain('599.999');
    const party = (await issuesOf({ 房间价格: rooms('6小时：999.999\n12小时 ：1599', null, '轰趴房') })).filter((i) => i.level === 'error');
    expect(party[0]!.message).toContain('999.999');

    const p = (await preview(workbook())).body as PriceImportPreview;
    const ball = find(p, '台球');
    const shorter = p.entries.map((e) => (e.name === '台球' ? { ...e, durationMinutes: 60 } : e));
    expect(diffPriceCatalogs(shorter, p.entries).map((d) => [d.change, d.draft?.name])).toEqual([['changed', '台球']]);
    expect(ball.durationMinutes).toBe(120);
  });

  it('第五轮审查：单条改动带操作编号（重提只记一次、作废后不生效）；按摩表少了「资深价」列报错；房间分档 0 小时报错', async () => {
    const ov = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview;
    const setId = (ov.draft ?? ov.active)!.id;
    const live = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${setId}`)).body as PriceCatalogSet;
    const item = live.entries.find((e) => e.sheet === 'entertainment' && e.active)!;
    const opKey = randomUUID();
    const body = { ...item, extraPriceCents: (item.extraPriceCents ?? 1000) + 100, extraMinutes: item.extraMinutes ?? 60, opKey };
    const first = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${item.id}`, body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // 原样重提（版本号已经旧了）：返回这一项现在的样子，不再写一次、不报版本冲突
    const again = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${item.id}`, body);
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(first.body.version);
    const [logged] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM price_catalog_changes WHERE op_key = ${opKey}`;
    expect(logged!.n).toBe(1);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${opKey}?type=price_entry`)).body).toMatchObject({ found: true, refId: item.id });
    // 作废过的编号：原请求晚到也不改
    const fenced = randomUUID();
    await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${fenced}/abandon`, { type: 'price_entry' });
    const late = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${item.id}/active`, { version: first.body.version, active: false, opKey: fenced });
    expect(late.body.error.code).toBe('OP_ABANDONED');
    // 缺编号不改
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${item.id}`, { ...first.body })).status).toBe(400);

    const massage = sheet('按摩及助浴价格', [
      ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价格'],
      ['康疗', 1, '古法中式', '房间', '80min', 499, 599],
    ]);
    const head = (await issuesOf({ 按摩及助浴价格: massage })).filter((i) => i.level === 'error');
    expect(head[0]).toMatchObject({ sheet: '按摩及助浴价格', row: 1, field: '表头' });
    expect(head[0]!.message).toContain('资深价');

    const rooms = (price: string, rule: string | null, type: string) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        [type, '7间', price, rule, 'R01-R07'],
      ]);
    for (const [price, rule, type] of [
      ['6小时：999\n0小时：999', null, '轰趴房'],
      ['小房间 599/晚', '499/0小时', '客房'],
    ] as const) {
      const errs = (await issuesOf({ 房间价格: rooms(price, rule, type) })).filter((i) => i.level === 'error');
      expect(errs[0], `${type} ${price} ${rule}`).toMatchObject({ sheet: '房间价格', row: 2 });
    }
  });

  it('第六轮审查：切换生效、放弃草稿带操作编号（重提什么都不改、作废后不生效）；娱乐表名称重复报错；按摩表说明列少了报错', async () => {
    const file = workbook();
    const p = (await preview(file)).body as PriceImportPreview & { digest: string };
    const draft = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: '第六轮.xlsx', xlsxBase64: file, previewDigest: p.digest, opKey: randomUUID() }))
      .body as PriceCatalogSet;
    const opKey = randomUUID();
    const on = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { draftId: draft.id, countReason: '演练', opKey });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    // 原样重提：什么都不改，返回现在的样子（不报「草稿已经变了」）
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { draftId: draft.id, countReason: '演练', opKey });
    expect(again.status).toBe(200);
    expect(again.body.active.id).toBe(draft.id);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${opKey}?type=price_set`)).body).toMatchObject({ found: true, refId: draft.id });
    // 放弃草稿：作废过的编号原请求晚到也不删
    const next = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: '第六轮二.xlsx', xlsxBase64: file, previewDigest: p.digest, opKey: randomUUID() }))
      .body as PriceCatalogSet;
    const fenced = randomUUID();
    await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${fenced}/abandon`, { type: 'price_set' });
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/discard', { draftId: next.id, opKey: fenced })).body.error.code).toBe('OP_ABANDONED');
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview).draft!.id).toBe(next.id);
    const drop = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/discard', { draftId: next.id, opKey: drop })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/discard', { draftId: next.id, opKey: drop })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${drop}?type=price_set`)).body).toMatchObject({ found: true });
    // 缺编号不切换
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { draftId: next.id })).status).toBe(400);

    const dupe = (
      await issuesOf({
        娱乐价格: ent([
          ['台球', 4, '39/2h', '加钟/19.9'],
          ['台 球', 4, '49/2h', '加钟/19.9'],
        ]),
      })
    ).filter((i) => i.level === 'error');
    expect(dupe[0]).toMatchObject({ sheet: '娱乐价格', row: 4, field: '名称' });
    expect(dupe[0]!.message).toContain('第 3 行');

    const massage = sheet('按摩及助浴价格', [
      ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人', '服务操作内容', '项目亮点'],
      ['康疗', 1, '古法中式', '房间', '80min', 499, 599, '久坐办公'],
    ]);
    expect((await issuesOf({ 按摩及助浴价格: massage })).find((i) => i.level === 'error')!.message).toContain('核心针对人群');
  });

  it('第七轮审查：房间分档写了不合法的金额报错；只改计价单位也算改价', async () => {
    const rooms = (price: string, rule: string | null, type: string) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        [type, '9间', price, rule, 'H201-H209'],
      ]);
    for (const [price, rule] of [
      ['6小时：0\n12小时：1599', null],
      ['6小时：999\n12小时：1599', '包天：0'],
    ] as const) {
      const errs = (await issuesOf({ 房间价格: rooms(price, rule, '轰趴房') })).filter((i) => i.level === 'error');
      expect(errs[0], `${price} ${rule}`).toMatchObject({ sheet: '房间价格', row: 2, field: '收费参考' });
    }
    const p = (await preview(workbook())).body as PriceImportPreview;
    const changed = p.entries.map((e) => (e.name === '生滚牛肉粥' ? { ...e, unit: '位' } : e));
    expect(diffPriceCatalogs(changed, p.entries).map((d) => [d.change, d.draft?.name])).toEqual([['changed', '生滚牛肉粥']]);
  });

  it('第八轮审查：房间写了封顶 / 超时却金额不对，报错（不当成没有封顶、没有超时价）', async () => {
    const rooms = (rule: string, type = 'spa房', price = '399/2H起开') =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        [type, '3间', price, rule, 'S301-S303'],
      ]);
    for (const rule of ['超时199/H\n0封顶过夜', '超时0/H\n999封顶过夜']) {
      const errs = (await issuesOf({ 房间价格: rooms(rule) })).filter((i) => i.level === 'error');
      expect(errs[0], rule).toMatchObject({ sheet: '房间价格', row: 2, field: '收费参考' });
    }
    const dining = (await issuesOf({ 房间价格: rooms('或者套餐低消', '餐饮包房', '688元/位\n次日11：00退房，超出按照0元/小时收费。') })).filter((i) => i.level === 'error');
    expect(dining[0]).toMatchObject({ row: 2, field: '收费参考' });
  });

  it('第九轮审查：餐饮包房「超出按照」金额认不出来报错；适用时段、是否含餐改了也算改价', async () => {
    const dining = (rule: string) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        ['餐饮包房', '5间', `688元/位\n次日11：00退房，${rule}`, null, '2楼：V999'],
      ]);
    for (const rule of ['超出按照-588元/小时收费。', '超出按照另议收费。']) {
      expect(
        (await issuesOf({ 房间价格: dining(rule) })).find((i) => i.level === 'error'),
        rule,
      ).toMatchObject({ row: 2, field: '收费参考' });
    }
    const p = (await preview(workbook())).body as PriceImportPreview;
    const breakfast = p.entries.find((e) => e.kind === 'meal_ticket')!;
    const later = p.entries.map((e) => (e === breakfast ? { ...e, windowStart: (e.windowStart ?? 0) + 30 } : e));
    expect(diffPriceCatalogs(later, p.entries).map((d) => [d.change, d.draft?.name])).toEqual([['changed', breakfast.name]]);
    const ticket = p.entries.find((e) => e.kind === 'ticket')!;
    const meal = p.entries.map((e) => (e === ticket ? { ...e, includesMeal: !e.includesMeal } : e));
    expect(diffPriceCatalogs(meal, p.entries)).toHaveLength(1);
  });

  it('第十轮审查：房间金额写成负数报错（不丢掉负号当正价）；菜品表少了「单位」列报错', async () => {
    const rooms = (type: string, price: string, rule: string | null) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        [type, '3间', price, rule, 'S301-S303'],
      ]);
    for (const [type, price, rule] of [
      ['客房', '小房间 -599/晚\n大房间 699/晚', '399/3小时'],
      ['spa房', '399/2H起开', '超时199/H\n-999封顶过夜'],
    ] as const) {
      const errs = (await issuesOf({ 房间价格: rooms(type, price, rule) })).filter((i) => i.level === 'error');
      expect(errs[0], price).toMatchObject({ row: 2, field: '收费参考' });
      expect(errs[0]!.message).toContain('负数');
    }
    const dishes = sheet('零点菜品价格', [['早餐自助零点菜品'], ['序号', '菜品分类', '菜品名称', '售价', '计价单位'], [1, '生滚粥', '生滚牛肉粥', 38, '份']], ['A1:E1']);
    expect((await issuesOf({ 零点菜品价格: dishes })).find((i) => i.level === 'error')!.message).toContain('单位');
  });

  it('第十一轮审查：轰趴房有一行分档认不出来，报错（不只留下认得的档）', async () => {
    const party = (price: string, rule: string | null) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        ['轰趴房', '9间', price, rule, '70平（H203-209) 4人位'],
      ]);
    for (const [price, rule] of [
      ['6小时：999\n12小时：abc', null],
      ['6小时：999\n12小时：1599', '包天：另议'],
    ] as const) {
      const errs = (await issuesOf({ 房间价格: party(price, rule) })).filter((i) => i.level === 'error');
      expect(errs[0], `${price} ${rule}`).toMatchObject({ row: 2, field: '收费参考' });
    }
  });

  it('第十三轮审查：客房过夜价 / 钟点价有一行认不出、两列个数对不上、负数，报错（不跳过再按先后配对）；条目与分档过多', async () => {
    const guest = (price: string, rule: string | null) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        ['客房', '7间', price, rule, 'R01-R07'],
      ]);
    for (const [price, rule] of [
      ['小房间 599/晚\n大房间 699/晚', 'abc/3小时\n499/3小时'],
      ['小房间 599/晚\n大房间 699/晚', '499/3小时'],
      ['小房间 599/晚\n大房间 另议', '399/3小时\n499/3小时'],
      ['小房间 -599/晚\n大房间 699/晚', null],
    ] as const) {
      const errs = (await issuesOf({ 房间价格: guest(price, rule) })).filter((i) => i.level === 'error');
      expect(errs[0], `${price} ${rule}`).toMatchObject({ row: 2, field: '收费参考' });
    }
    // 正常的照旧：大小房各一档过夜价、一档钟点价，钟点价配给对的房
    const ok = await preview(workbook({ 房间价格: guest('小房间 599/晚\n大房间 699/晚', '399/3小时\n499/3小时') }));
    const room = find(ok.body as PriceImportPreview, '客房');
    expect(room.variants.map((v) => [v.label, v.priceCents])).toEqual([
      ['小房间 过夜', 59900],
      ['大房间 过夜', 69900],
      ['小房间 3小时', 39900],
      ['大房间 3小时', 49900],
    ]);

    // 一项的分档太多（一格写了 21 个位价，超过页面编辑的上限 20 档）：报错
    const many = Array.from({ length: 21 }, (_, i) => `${600 + i}元/位`).join('\n');
    const dining = sheet('房间价格', [
      ['房型', '总数', '收费参考', null, '备注'],
      ['餐饮包房', '5间', many, null, 'V999'],
    ]);
    expect((await issuesOf({ 房间价格: dining })).some((i) => i.level === 'error' && i.message.includes('超过 20 档'))).toBe(true);
    // 整份认出的项过多：整份拒绝
    const rows: Row[] = [['2楼餐厅零点菜品'], ['序号', '菜品分类', '菜品名称', '售价', '单位']];
    for (let i = 1; i <= 1990; i += 1) rows.push([i, '中餐零点', `菜品${i}`, 38, '份']);
    const big = sheet('零点菜品价格', rows, ['A1:E1']);
    const massage: Row[] = [['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点']];
    for (let i = 1; i <= 1100; i += 1) massage.push(['康疗', i, `项目${i}`, '房间', '80min', 499, 599]);
    const res = await preview(workbook({ 零点菜品价格: big, 按摩及助浴价格: sheet('按摩及助浴价格', massage) }));
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'IMPORT_FILE_INVALID' });
    expect(res.body.error.message).toContain('超过 3000 项');
  });

  it('第十二轮审查：同名的停用项不会盖掉在用项，在用项改价照样对比得出', async () => {
    const p = (await preview(workbook())).body as PriceImportPreview;
    const congee = find(p, '生滚牛肉粥');
    const retiredTwin = { ...congee, active: false, priceCents: 9900, sortOrder: congee.sortOrder + 100 };
    const activeSide = [...p.entries, retiredTwin];
    const draftSide = [...p.entries.map((e) => (e === congee ? { ...e, priceCents: 5800 } : e)), retiredTwin];
    expect(diffPriceCatalogs(draftSide, activeSide).map((d) => [d.change, d.draft?.name, d.draft?.priceCents])).toEqual([['changed', '生滚牛肉粥', 5800]]);
  });
});

describe('价目表录入 第四批：前台试算', () => {
  it('收银台按生效中的价目表试算：1 间 SPA 房 + 1 个康疗项目 + 1 张门票，小计与 10% 服务费；超时、封顶、加钟、资深价、分档、待定价', async () => {
    const file = workbook();
    const p = (await preview(file)).body as PriceImportPreview & { digest: string };
    const draft = (
      await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: '试算.xlsx', xlsxBase64: file, previewDigest: p.digest, title: '第四批试算', opKey: randomUUID() })
    ).body as PriceCatalogSet;
    const on = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { opKey: randomUUID(), draftId: draft.id, countReason: '合成的演练表' });
    expect(on.status, JSON.stringify(on.body)).toBe(200);

    // 前台店员能读生效中的价目表（只含在用的）；没登录的不行
    const res = await api(ctx.app, ctx.clerk, 'GET', '/api/price-catalog/active');
    expect(res.status).toBe(200);
    const active = res.body as { set: { id: number; title: string }; entries: PriceCatalogEntry[] };
    expect(active.set).toMatchObject({ id: draft.id, title: '第四批试算' });
    expect(active.entries.every((e) => e.active)).toBe(true);
    expect((await api(ctx.app, '', 'GET', '/api/price-catalog/active')).status).toBe(401);
    const get = (name: string) => active.entries.find((e) => e.name === name)!;
    const fee = get('服务费');

    // 需求说明的试算：spa房用了 2.5 小时（起开 399 含 2 小时，超时 1 × 199）+ 古法中式专业价 499 + 门票 12H 不含餐 499
    const q = priceQuote(
      [
        { entry: get('spa房'), minutes: 150, quantity: 1 },
        { entry: get('古法中式'), quantity: 1 },
        { entry: get('12H 不含餐'), quantity: 1 },
      ],
      fee,
    );
    expect(q.problems).toEqual([]);
    expect(q.lines.map((l) => [l.name, l.amountCents])).toEqual([
      ['spa房', 59800],
      ['古法中式', 49900],
      ['12H 不含餐', 49900],
    ]);
    expect(q).toMatchObject({ subtotalCents: 159600, feeRateBp: 1000, feeCents: 15960, totalCents: 175560 });

    // 超时到封顶为止；娱乐加钟；资深价；轰趴房选档；待定价的菜算不了
    expect(quoteUnit({ entry: get('spa房'), minutes: 600 })).toMatchObject({ unitCents: 99900 });
    expect(quoteUnit({ entry: get('台球'), minutes: 150 })).toMatchObject({ unitCents: 5890 });
    expect(quoteUnit({ entry: get('古法中式'), tier: 'senior' })).toMatchObject({ unitCents: 59900 });
    const party = get('轰趴房');
    expect(quoteUnit({ entry: party, variant: party.variants.findIndex((v) => v.label.includes('150平') && v.label.includes('包天')) })).toMatchObject({ unitCents: 600000 });
    const q2 = priceQuote(
      [
        { entry: get('沙姜炒鸡'), quantity: 1 },
        { entry: get('台球'), quantity: 2 },
      ],
      fee,
    );
    expect(q2.problems).toEqual(['「沙姜炒鸡」不可下单']);
    expect(q2).toMatchObject({ subtotalCents: 7800, feeCents: 780, totalCents: 8580 });
    // 服务费四舍五入到分
    expect(serviceFeeOf(5890, 1000)).toBe(589);
    expect(serviceFeeOf(1995, 1000)).toBe(200);
    expect(serviceFeeOf(1994, 1000)).toBe(199);
    // 超时价与每次分钟要成对（只填价、不填分钟的保存不了，不会出现写着超时价却不计超时）
    expect(priceEntryProblems({ ...get('spa房'), extraMinutes: null })).toContain('填了加钟 / 超时价，也要填每次多少分钟');
    expect(priceEntryProblems({ ...get('spa房'), durationMinutes: null })).toContain('填了加钟 / 超时价，也要填基础价含多少分钟');
    expect(priceEntryProblems({ ...get('台球'), durationMinutes: null })).toContain('填了加钟 / 超时价，也要填基础价含多少分钟');
    // 取消了「可以下单」的非菜品项目同样算不了
    const off = priceQuote([{ entry: { ...get('台球'), orderable: false }, quantity: 1 }], fee);
    expect(off).toMatchObject({ problems: ['「台球」不可下单'], subtotalCents: 0, feeCents: 0, totalCents: 0 });
    // 停用了服务费的：不加
    expect(priceQuote([{ entry: get('台球'), quantity: 1 }], { ...fee, active: false })).toMatchObject({ feeRateBp: null, feeCents: 0, totalCents: 3900 });
  });
});

describe('价目表录入 第四批：对接收银项目', () => {
  const activateNew = async (title: string) => {
    const file = workbook();
    const p = (await preview(file)).body as PriceImportPreview & { digest: string };
    const draft = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: `${title}.xlsx`, xlsxBase64: file, previewDigest: p.digest, title, opKey: randomUUID() }))
      .body as PriceCatalogSet;
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { opKey: randomUUID(), draftId: draft.id, countReason: '合成的演练表' })).status).toBe(200);
    return draft;
  };
  const item = async (body: Record<string, unknown>) => {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/items', body)).status).toBe(200);
    const [row] = await ctx.sql<{ id: number }[]>`SELECT id FROM service_items WHERE name = ${body.name as string} ORDER BY id DESC LIMIT 1`;
    return Number(row!.id);
  };
  const tiers = async (id: number) =>
    Object.fromEntries((await ctx.sql<{ tier: string; price: number }[]>`SELECT tier, price FROM service_item_prices WHERE item_id = ${id} ORDER BY tier`).map((r) => [r.tier, Number(r.price)]));
  const link = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/links', { opKey: randomUUID(), ...body });

  it('按名称自动对接、手工对接 / 取消；切换、改价、回滚时收银项目的价跟着变，已开的单不变；后台价目不能另改对接了的项目的价', async () => {
    // 前面几条用例切换生效时已经落过库：清掉，从「门店原有的收银项目」开始
    await ctx.sql`DELETE FROM price_catalog_links`;
    await ctx.sql`UPDATE service_items SET active = false, catalog_managed = false, catalog_key = NULL WHERE catalog_managed`;
    const yoga = await item({ name: '瑜伽泰式', category: '按摩', prices: { standard: 50000 }, technicianRequired: true });
    const pool = await item({ name: '台 球', category: '娱乐', price: 3000 });
    const snooker1 = await item({ name: '斯诺克', category: '娱乐', price: 9000 });
    const snooker2 = await item({ name: '斯诺克', category: '娱乐', price: 9100 });
    await activateNew('对接演练上一版');
    const set = await activateNew('对接演练');

    // 切换生效时落库（重做第一批）：名称（不管空格）恰好对上一个在用项目的对上它；两个「斯诺克」对不准，另建一个价目表的收银项目
    const opKey = randomUUID();
    const auto = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/links/auto', { opKey });
    expect(auto.status, JSON.stringify(auto.body)).toBe(200);
    expect(auto.body).toMatchObject({ linked: 0 });
    const links = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog/links')).body as { entryKey: string; itemId: number; prices: { tier: string; price: number }[] }[];
    const keyOf = (name: string) => links.find((l) => l.entryKey.endsWith(`|${name}`))?.itemId;
    expect(keyOf('瑜伽泰式')).toBe(yoga);
    expect(keyOf('台球')).toBe(pool);
    expect([snooker1, snooker2]).not.toContain(keyOf('斯诺克'));
    expect(keyOf('斯诺克')).toBeDefined();
    // 双价：标准 / 专业 = 专业价，优选 = 资深价（PC7）；单价：每一档都是这个价
    expect(await tiers(yoga)).toEqual({ premium: 69900, professional: 59900 });
    expect(await tiers(pool)).toEqual({ standard: 3900 });
    // 原样重提：返回第一次的结果，不再对一遍
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/links/auto', { opKey });
    expect(again.body).toEqual(auto.body);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${opKey}?type=price_link`)).body).toMatchObject({ found: true });

    // 后台价目改对接了的项目的价被拒；8.1.34 起名称、分类也以价目表为准（说明、排序、停用这些照常能改）
    const edit = await api(ctx.app, ctx.owner, 'PUT', `/api/items/${pool}`, { name: '台 球', category: '娱乐', price: 3500 });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('PRICE_LINKED');
    // 价目表新建的（斯诺克）：名称、分类随价目表同步，这里改名被拒
    const managed = keyOf('斯诺克')!;
    const [mp] = (await ctx.sql<{ price: number }[]>`SELECT price FROM service_item_prices WHERE item_id = ${managed} ORDER BY tier LIMIT 1`) as unknown as [{ price: number }];
    const renameRefused = await api(ctx.app, ctx.owner, 'PUT', `/api/items/${managed}`, { name: '桌上斯诺克', category: '娱乐', price: Number(mp.price) });
    expect(renameRefused.body.error?.code).toBe('PRICE_LINKED');
    expect(renameRefused.body.error?.message).toContain('名称、分类');
    // 门店原有、后来对接上的（台 球）：价目表不改它的名称、分类，这里照常能改（Codex 审查：不然两边都改不了）；改价照旧被拒
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/items/${pool}`, { name: '桌球', category: '娱乐', price: 3900 })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/items/${pool}`, { name: '台 球', category: '娱乐', price: 3900 })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/items/${pool}`, { name: '台 球', category: '娱乐', price: 3900, note: '按小时' })).status).toBe(200);

    // 前台挂账按收银项目取价 = 价目表的价
    await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'P', from: 1, to: 2, width: 3, zone: 'male' });
    const visit = (await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'P001', zone: 'male' }] })).body.visits[0].id as number;
    const charge = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visit}/charges`, { clientKey: randomUUID(), lines: [{ itemId: pool, quantity: 2 }], expectedTotal: 7800 });
    expect(charge.status, JSON.stringify(charge.body)).toBe(200);

    // 改生效中的价目：收银项目跟着变；已开的单照旧
    const active = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${set.id}`)).body as PriceCatalogSet;
    const poolEntry = find(active, '台球');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${poolEntry.id}`, { ...poolEntry, priceCents: 4500, opKey: randomUUID() })).status).toBe(200);
    expect(await tiers(pool)).toEqual({ standard: 4500 });
    const [line] = await ctx.sql<{ unitPrice: number }[]>`SELECT unit_price FROM bill_lines WHERE item_id = ${pool}`;
    expect(Number(line!.unitPrice)).toBe(3900);
    // 改名：对接跟着这一项走
    const renamed = (
      await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${poolEntry.id}`, {
        ...poolEntry,
        version: poolEntry.version! + 1,
        name: '台球（2 小时）',
        priceCents: 4500,
        opKey: randomUUID(),
      })
    ).body as PriceCatalogEntry;
    expect(renamed.name).toBe('台球（2 小时）');
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog/links')).body as { entryKey: string; itemId: number }[]).find((l) => l.itemId === pool)?.entryKey).toMatch(
      /台球（2小时）$/,
    );

    // 手工对接：斯诺克对第一个；换成第二个（原来那个取消）；一个收银项目只对一项
    const snookerKey = `entertainment|||斯诺克`;
    const l1 = await link({ entryKey: snookerKey, itemId: snooker1 });
    expect(l1.status, JSON.stringify(l1.body)).toBe(200);
    expect(l1.body).toMatchObject({ linked: 1, unlinked: 1, synced: [{ itemId: snooker1, changed: true }] });
    expect(await tiers(snooker1)).toEqual({ standard: 9900 });
    expect((await link({ entryKey: snookerKey, itemId: snooker2 })).body).toMatchObject({ linked: 1, unlinked: 1 });
    expect(await tiers(snooker2)).toEqual({ standard: 9900 });
    const taken = await link({ entryKey: snookerKey, itemId: yoga });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('PRICE_LINK_TAKEN');
    expect((await link({ entryKey: 'massage|康疗||不存在的项目', itemId: snooker1 })).status).toBe(404);
    // 取消对接以后后台价目又能改价
    expect((await link({ entryKey: snookerKey, itemId: null })).body).toMatchObject({ unlinked: 1 });
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/items/${snooker2}`, { name: '斯诺克', category: '娱乐', price: 8800 })).status).toBe(200);

    // 改双价：专业 619、资深 719
    const yogaEntry = find(active, '瑜伽泰式');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${yogaEntry.id}`, { ...yogaEntry, priceCents: 61900, price2Cents: 71900, opKey: randomUUID() })).status).toBe(200);
    expect(await tiers(yoga)).toEqual({ premium: 71900, professional: 61900 });

    // 整体回滚：收银项目回到上一版的价（瑜伽泰式 599 / 699）；改了名的台球在上一版里没有这个名字，不动（同步结果里写明）；同步记审计
    const overview = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as PriceCatalogOverview;
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/rollback', { opKey: randomUUID(), activeId: overview.active!.id, reason: '演练回滚' })).status).toBe(200);
    expect(await tiers(yoga)).toEqual({ premium: 69900, professional: 59900 });
    expect(await tiers(pool)).toEqual({ standard: 4500 });
    const audits = await ctx.sql<{ detail: { action: string; label: string } }[]>`SELECT detail FROM audit_logs WHERE action = 'price_catalog' ORDER BY id`;
    expect(audits.map((a) => a.detail.action)).toEqual(expect.arrayContaining(['link', 'unlink', 'sync']));
    expect(audits.filter((a) => a.detail.action === 'sync').at(-1)!.detail.label).toContain('整体回滚');

    // 作废过的编号：原请求晚到也不对接；店员不能对接
    const dead = randomUUID();
    await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${dead}/abandon`, { type: 'price_link' });
    const late = await link({ opKey: dead, entryKey: snookerKey, itemId: snooker1 });
    expect(late.body.error?.code).toBe('OP_ABANDONED');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/price-catalog/links/auto', { opKey: randomUUID() })).status).toBe(403);
  });

  it('第十四轮审查：同名的停用历史项改名，不把在用项的对接迁走；在用项改价照样同步', async () => {
    const set = await activateNew('对接改名演练');
    const ball = await item({ name: `乒乓球演练${Date.now() % 100000}`, category: '娱乐', price: 3000 });
    const entries = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${set.id}`)).body as PriceCatalogSet;
    const old = find(entries, '乒乓球');
    // 停用原来那项，再新增一项同名的（在用），对接收银项目
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${old.id}/active`, { version: old.version, active: false, reason: '换新', opKey: randomUUID() })).status).toBe(200);
    const created = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/sets/${set.id}/entries`, { ...old, active: undefined, priceCents: 4900, opKey: randomUUID() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const fresh = created.body as PriceCatalogEntry;
    const key = 'entertainment|||乒乓球';
    expect((await link({ entryKey: key, itemId: ball })).status).toBe(200);
    expect(await tiers(ball)).toEqual({ standard: 4900 });
    // 改停用的那项的名字：对接留在原来的键上
    const stale = ((await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${set.id}`)).body as PriceCatalogSet).entries.find((e) => e.id === old.id)!;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${old.id}`, { ...stale, name: '乒乓球（旧）', opKey: randomUUID() })).status).toBe(200);
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog/links')).body as { entryKey: string; itemId: number }[]).find((l) => l.itemId === ball)?.entryKey).toBe(key);
    // 在用的那项改价，收银项目跟着变
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${fresh.id}`, { ...fresh, priceCents: 5900, opKey: randomUUID() })).status).toBe(200);
    expect(await tiers(ball)).toEqual({ standard: 5900 });
  });

  it('第十五轮审查：房号上限导入、校验、编辑一致（201 个房号能导也能改；超过 300 个导入报错）', async () => {
    const spa = (rooms: string) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        ['spa房', '201间', '399/2H起开', '超时199/H\n999封顶过夜', rooms],
      ]);
    const file = workbook({ 房间价格: spa('S001-S201') });
    const p = (await preview(file)).body as PriceImportPreview & { digest: string };
    expect(p.errorCount).toBe(0);
    expect(find(p, 'spa房').roomNumbers).toHaveLength(201);
    const draft = (
      await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: '房号.xlsx', xlsxBase64: file, previewDigest: p.digest, title: '房号演练', opKey: randomUUID() })
    ).body as PriceCatalogSet;
    const e = find(draft, 'spa房');
    const saved = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${e.id}`, { ...e, note: '只改备注', opKey: randomUUID() });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const over = ((await preview(workbook({ 房间价格: spa('S001-S200 S201-S301') }))).body as PriceImportPreview).issues;
    expect(over.some((i) => i.level === 'error' && i.message.includes('超过 300 个'))).toBe(true);
  });

  it('第十六轮审查：停用已对接的项、新增同名的一项，收银项目马上换成新的价；长的房号区间照实展开', async () => {
    const set = await activateNew('新增同步演练');
    const ball = await item({ name: `手动足球演练${Date.now() % 100000}`, category: '娱乐', price: 3000 });
    const key = 'entertainment|||手动足球';
    expect((await link({ entryKey: key, itemId: ball })).status).toBe(200);
    expect(await tiers(ball)).toEqual({ standard: 3900 });
    const old = find((await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${set.id}`)).body as PriceCatalogSet, '手动足球');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${old.id}/active`, { version: old.version, active: false, reason: '换新', opKey: randomUUID() })).status).toBe(200);
    const created = await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/sets/${set.id}/entries`, { ...old, active: undefined, priceCents: 4900, opKey: randomUUID() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await tiers(ball)).toEqual({ standard: 4900 });

    // 房号区间：S001-S300 照实 300 个；S001-S301 报「超过 300 个」（不再悄悄当成一个房号）
    const spa = (rooms: string) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        ['spa房', '300间', '399/2H起开', '超时199/H\n999封顶过夜', rooms],
      ]);
    const ok = (await preview(workbook({ 房间价格: spa('S001-S300') }))).body as PriceImportPreview;
    expect(find(ok, 'spa房').roomNumbers).toHaveLength(300);
    const over = ((await preview(workbook({ 房间价格: spa('S001-S301') }))).body as PriceImportPreview).issues;
    expect(over.some((i) => i.level === 'error' && i.message.includes('超过 300 个'))).toBe(true);
  });

  it('第二十二轮审查：餐饮包房写了「低消」却认不出金额，报错（不当成没有最低消费）', async () => {
    const dining = (price: string) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        ['餐饮包房', '5间', price, null, 'V999'],
      ]);
    const bad = ((await preview(workbook({ 房间价格: dining('688元/位\n低消：另议') }))).body as PriceImportPreview).issues.filter((i) => i.level === 'error');
    expect(bad[0]).toMatchObject({ row: 2, field: '收费参考' });
    // 位价逐行核对：有一行认不出（「abc元/位」）报错，不只留下认得的那档
    const badSeat = ((await preview(workbook({ 房间价格: dining('688元/位（只限餐饮）\nabc元/位（只限餐饮）') }))).body as PriceImportPreview).issues.filter((i) => i.level === 'error');
    expect(badSeat[0]).toMatchObject({ row: 2, field: '收费参考' });
    const ok = (await preview(workbook({ 房间价格: dining('688元/位\n低消：3000') }))).body as PriceImportPreview;
    expect(ok.errorCount).toBe(0);
    expect(find(ok, '餐饮包房').variants.map((v) => [v.label, v.priceCents])).toEqual([
      ['位价', 68800],
      ['低消', 300000],
    ]);
  });

  it('第二十三轮审查：房间金额带千位分隔符（「3,000」「1,999」）报错，不截成一段当价格', async () => {
    const room = (type: string, price: string, rule: string | null, note: string) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        [type, '5间', price, rule, note],
      ]);
    for (const s of [
      room('餐饮包房', '688元/位\n低消：3,000', null, 'V999'),
      room('轰趴房', '6小时：1,999\n12小时：2599', null, '70平（H203-209) 4人位'),
      room('spa房', '399/2H起开', '超时199/H\n1,999封顶过夜', 'S301-S305'),
    ]) {
      const errs = ((await preview(workbook({ 房间价格: s }))).body as PriceImportPreview).issues.filter((i) => i.level === 'error');
      expect(errs.some((i) => i.row === 2 && i.message.includes('千位分隔符'))).toBe(true);
    }
    // 娱乐的加钟价同样不截：「加钟/1,999」报错；「加钟/19.9，周末另算」照常认 19.9
    const ent = (note: string) => sheet('娱乐价格', [['汤崎'], ['类型', '数量', '价格', '备注'], ['台球', 4, '39/2h', note]]);
    const bad = ((await preview(workbook({ 娱乐价格: ent('加钟/1,999') }))).body as PriceImportPreview).issues.filter((i) => i.level === 'error');
    expect(bad[0]).toMatchObject({ row: 3, field: '备注' });
    const ok = (await preview(workbook({ 娱乐价格: ent('加钟/19.9，周末另算') }))).body as PriceImportPreview;
    expect(ok.errorCount).toBe(0);
    expect(find(ok, '台球').extraPriceCents).toBe(1990);
  });

  it('第二十六轮审查：按时计费的房型另写的价格档逐行核对（「abc/12H」报错，不只留下 8H 档）', async () => {
    const chess = (rule: string) =>
      sheet('房间价格', [
        ['房型', '总数', '收费参考', null, '备注'],
        ['棋牌房', '5间', '399/2H起开', rule, 'Q301 Q302'],
      ]);
    const bad = ((await preview(workbook({ 房间价格: chess('超时199/H\n699/8H\nabc/12H') }))).body as PriceImportPreview).issues.filter((i) => i.level === 'error');
    expect(bad[0]).toMatchObject({ row: 2, field: '收费参考' });
    const ok = (await preview(workbook({ 房间价格: chess('超时199/H\n699/8H\n999封顶') }))).body as PriceImportPreview;
    expect(ok.errorCount).toBe(0);
    expect(find(ok, '棋牌房').variants.map((v) => [v.label, v.priceCents])).toEqual([['8小时', 69900]]);
  });

  it('第二十七轮审查：分档说明等字段的长度上限导入与编辑一致（低消说明超过 200 字报错）', async () => {
    const dining = sheet('房间价格', [
      ['房型', '总数', '收费参考', null, '备注'],
      ['餐饮包房', '5间', `688元/位\n低消：3000元起${'含酒水'.repeat(70)}`, null, 'V999'],
    ]);
    const errs = ((await preview(workbook({ 房间价格: dining }))).body as PriceImportPreview).issues.filter((i) => i.level === 'error');
    expect(errs.some((i) => i.message.includes('说明最多 200 个字'))).toBe(true);
    const e = find((await preview(workbook())).body as PriceImportPreview, '古法中式');
    expect(priceEntryProblems({ ...e, content: 'x'.repeat(801) })).toContain('服务操作内容最多 800 个字');
    // 导入时不先截断：服务操作内容 801 字的那一行报错，不悄悄裁成 800 字导进来
    const massage = sheet('按摩及助浴价格', [
      ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点'],
      ['康疗', 1, '古法中式', '房间', '80min', 499, 599, '久坐', '甲'.repeat(801), '亮点'],
    ]);
    const long = ((await preview(workbook({ 按摩及助浴价格: massage }))).body as PriceImportPreview).issues.filter((i) => i.level === 'error');
    expect(long.some((i) => i.row === 2 && i.message.includes('服务操作内容最多 800 个字'))).toBe(true);
  });

  it('第二十九轮审查：相邻两行写了同一个房型（不是轰趴房），后一行报错，不悄悄丢掉', async () => {
    const twice = sheet('房间价格', [
      ['房型', '总数', '收费参考', null, '备注'],
      ['spa房', '1间', '399/2H起开', '超时199/H', 'S301'],
      ['spa房', '1间', '599/2H起开', '超时199/H', 'S302'],
    ]);
    const errs = ((await preview(workbook({ 房间价格: twice }))).body as PriceImportPreview).issues.filter((i) => i.level === 'error');
    expect(errs.some((i) => i.row === 3 && i.field === '房型')).toBe(true);
  });

  it('第三十轮审查：菜品、按摩缺了名称却还写着价格等内容，报错（不当空行跳过）', async () => {
    const dish = sheet('零点菜品价格', [['早餐自助零点菜品'], ['序号', '菜品分类', '菜品名称', '售价', '单位'], [1, '生滚粥', '生滚牛肉粥', 38, '份'], [2, '生滚粥', null, 58, '份']], ['A1:E1']);
    const d = ((await preview(workbook({ 零点菜品价格: dish }))).body as PriceImportPreview).issues.filter((i) => i.level === 'error');
    expect(d.some((i) => i.row === 4 && i.field === '菜品名称')).toBe(true);
    const massage = sheet('按摩及助浴价格', [
      ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点'],
      ['康疗', 1, '古法中式', '房间', '80min', 499, 599],
      ['康疗', 2, null, '房间', '90min', 599, 699],
    ]);
    const m = ((await preview(workbook({ 按摩及助浴价格: massage }))).body as PriceImportPreview).issues.filter((i) => i.level === 'error');
    expect(m.some((i) => i.row === 3 && i.field === '项目名称')).toBe(true);
  });
});

describe('价目表重做 第一批：分类与落库到收银项目', () => {
  it('分类编码 + 分类名称独立存，不拼进名称；顺序与表格一致；同一个分类在哪儿编码都一样', () => {
    const p = parsePriceCatalog(readXlsx(Buffer.from(workbook(), 'base64')));
    expect(p.entries.filter((e) => e.sheet === 'store').map((e) => e.name)).toEqual(['12H 不含餐', '12H 含餐', '24H 不含餐', '24H 含餐', '夜间票', '早餐', '午餐', '晚餐', '夜宵', '服务费']);
    const { categories, byEntry } = priceCategoriesOf(p.entries);
    const cat = (name: string) => byEntry[p.entries.findIndex((e) => e.name === name)]!;
    expect(cat('12H 不含餐')).toMatchObject({ code: 'store.ticket', name: '门票', group: '门店价格' });
    expect(cat('早餐')).toMatchObject({ code: 'store.meal', name: '餐票' });
    expect(cat('畅玩卷')).toMatchObject({ code: 'ent.pass', name: '畅玩卷' });
    expect(cat('台球')).toMatchObject({ code: 'ent.play', name: '娱乐设施' });
    expect(cat('spa房')).toMatchObject({ name: 'spa房', group: '房间价格' });
    expect(cat('古法中式')).toMatchObject({ code: 'massage.01', name: '康疗' });
    expect(cat('精致修脚')).toMatchObject({ code: 'massage.06', name: '大堂按摩' });
    // 菜品「餐段 → 分类」两级：早餐、午餐都有的分类名编码不同
    expect(cat('生滚牛肉粥')).toMatchObject({ name: '生滚粥', group: '早餐' });
    expect(cat('玻璃脆皮妙龄乳鸽').code).not.toBe(cat('蚝皇扣鲍鱼').code);
    expect(categories.map((c) => c.name).slice(0, 6)).toEqual(['门票', '夜间票', '餐票', '服务费', '畅玩卷', '娱乐设施']);
    expect(categories.filter((c) => c.code.startsWith('massage.')).map((c) => c.name)).toEqual(['康疗', '中医', '面护', '大堂按摩', '助浴', '护理']);
    // 稳定：同一个分类再算一次是同一个编码
    expect(priceCategoryOf(p.entries.find((e) => e.name === 'spa房')!).code).toBe(cat('spa房').code);
  });

  it('切换生效后每一项都有收银项目（服务费、房型、门票除外，待定价的不建）；前台按价目表的分类切换；停用跟着走；补价后建出来', async () => {
    // 从一家还没有收银项目的门店开始（前面的用例建过同名的）
    await ctx.sql`DELETE FROM price_catalog_links`;
    await ctx.sql`UPDATE service_items SET active = false, catalog_managed = false, catalog_key = NULL`;
    await ctx.sql`INSERT INTO kitchen_stations (name) SELECT '演练热菜' WHERE NOT EXISTS (SELECT 1 FROM kitchen_stations WHERE active)`;
    const file = workbook();
    const p = (await preview(file)).body as PriceImportPreview & { digest: string };
    const draft = (
      await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: '落库.xlsx', xlsxBase64: file, previewDigest: p.digest, title: '落库演练', opKey: randomUUID() })
    ).body as PriceCatalogSet;
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { opKey: randomUUID(), draftId: draft.id, countReason: '合成的演练表' })).status).toBe(200);

    const managed = await ctx.sql<
      { id: number; name: string; category: string; active: boolean; code: string; catName: string; technicianRequired: boolean; durationMinutes: number | null; stationId: number | null }[]
    >`
      SELECT id, name, category, active, catalog_category_code AS code, catalog_category_name AS cat_name, technician_required, duration_minutes, station_id
      FROM service_items WHERE catalog_managed ORDER BY catalog_sort, id`;
    const byName = (n: string) => managed.find((m) => m.name === n);
    // 餐票 4 + 娱乐 8 + 菜品 4（2 楼零点两道待定价不建）+ 按摩 10；服务费、房间不建；
    // 门票、夜间票 8.1.34 起也不建（门票费按「门票」票种结账，再建一个能挂单的项目会重复收费）
    expect(managed.filter((m) => m.active)).toHaveLength(4 + 8 + 4 + 10);
    expect(byName('服务费')).toBeUndefined();
    expect(byName('12H 不含餐')).toBeUndefined();
    expect(byName('spa房')).toBeUndefined();
    expect(byName('沙姜炒鸡')).toBeUndefined();
    expect(byName('早餐')).toMatchObject({ code: 'store.meal', catName: '餐票', category: '餐饮' });
    expect(byName('古法中式')).toMatchObject({ code: 'massage.01', catName: '康疗', category: '康疗', technicianRequired: true, durationMinutes: 80 });
    expect(byName('生滚牛肉粥')!.stationId).not.toBeNull();
    const tiers = async (id: number) =>
      Object.fromEntries((await ctx.sql<{ tier: string; price: number }[]>`SELECT tier, price FROM service_item_prices WHERE item_id = ${id} ORDER BY tier`).map((r) => [r.tier, Number(r.price)]));
    expect(await tiers(byName('古法中式')!.id)).toEqual({ premium: 59900, professional: 49900 });
    expect(await tiers(byName('台球')!.id)).toEqual({ standard: 3900 });

    // 前台取的收银项目带分类；分类切换按价目表的名称与顺序
    const catalog = (await api(ctx.app, ctx.clerk, 'GET', '/api/catalog')).body as Catalog;
    const ticket = catalog.items.find((i) => i.name === '早餐')!;
    expect(ticket.catalogCategory).toMatchObject({ code: 'store.meal', name: '餐票', group: '门店价格' });
    const tabs = itemCategoryTabs(catalog.items.filter((i) => i.catalogCategory));
    expect(tabs.map((t) => t.label).slice(0, 2)).toEqual(['餐票', '畅玩卷']);
    expect(tabs.find((t) => t.label === '门票')).toBeUndefined();
    expect(tabs.find((t) => t.label === '餐票')!.count).toBe(4);
    expect(tabs.find((t) => t.label === '康疗')!.count).toBe(2);
    expect(itemCategoryKey(ticket)).toBe('store.meal');
    // 第五批：点单搜项目——名称或价目表编号（不分大小写、不管空格）
    const gufa = catalog.items.find((i) => i.name === '古法中式')!;
    expect(gufa.catalogCode).toBe('1');
    expect(matchesItemSearch(ticket, '早 餐')).toBe(true);
    expect(matchesItemSearch(gufa, '1')).toBe(true);
    expect(matchesItemSearch(gufa, '泰式')).toBe(false);
    // 第二批：房态中心登记（康美部）只列要技师的、房间 / 大堂做的板块，按表格顺序；助浴、护理在浴区，不在这里列（PC22）
    const service = catalog.items.filter((i) => i.technicianRequired && !ROOM_SERVICE_EXCLUDED_CATEGORIES.includes(i.catalogCategory?.code ?? ''));
    expect(itemCategoryTabs(service).map((t) => `${t.label}:${t.count}`)).toEqual(['康疗:2', '中医:1', '面护:2', '大堂按摩:1']);
    expect(catalog.items.find((i) => i.name === '伊索抗衰面部护理')).toMatchObject({
      durationMinutes: 80,
      prices: [
        { tier: 'professional', price: 80000 },
        { tier: 'premium', price: 90000 },
      ],
    });
    expect(catalog.items.find((i) => i.name === '泰式私汤药浴(女宾)')).toMatchObject({ gender: 'female', catalogCategory: { code: 'massage.08', name: '助浴' } });

    // 第三批：点单页的菜单带「餐段 → 菜品分类」；2 楼零点两道待定价的不在菜单里（不能下单）
    const menu = (await api(ctx.app, ctx.owner, 'GET', '/api/dining/menu')).body as DiningMenu;
    const fromCatalog = menu.dishes.filter((d) => d.catalogCategory);
    expect(fromCatalog.map((d) => `${d.catalogCategory!.group}/${d.catalogCategory!.name}/${d.name}`).sort()).toEqual(
      ['早餐/生滚粥/生滚牛肉粥', '早餐/生滚粥/皮蛋瘦肉粥', '午餐/中式零点/玻璃脆皮妙龄乳鸽', '晚餐/中式零点/蚝皇扣鲍鱼'].sort(),
    );
    expect(fromCatalog.every((d) => d.outlet === 'restaurant')).toBe(true);
    // 午餐、晚餐都有「中式零点」：编码不同，分开切换
    const lunch = fromCatalog.find((d) => d.name === '玻璃脆皮妙龄乳鸽')!;
    const dinner = fromCatalog.find((d) => d.name === '蚝皇扣鲍鱼')!;
    expect(itemCategoryKey(lunch)).not.toBe(itemCategoryKey(dinner));
    expect(itemCategoryTabs(fromCatalog).map((t) => t.label)).toEqual(['生滚粥', '午餐 · 中式零点', '晚餐 · 中式零点']);

    // 前台挂一份早餐：按价目表的价
    await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 2, width: 3, zone: 'male' });
    const visit = (await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'K001', zone: 'male' }] })).body.visits[0].id as number;
    const charge = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visit}/charges`, { clientKey: randomUUID(), lines: [{ itemId: ticket.id, quantity: 1 }], expectedTotal: 9900 });
    expect(charge.status, JSON.stringify(charge.body)).toBe(200);

    // 停用价目表的一项：收银项目跟着停用；启用回来
    const set = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${draft.id}`)).body as PriceCatalogSet;
    const pool = find(set, '台球');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${pool.id}/active`, { version: pool.version, active: false, opKey: randomUUID() })).status).toBe(200);
    expect((await ctx.sql<{ active: boolean }[]>`SELECT active FROM service_items WHERE id = ${byName('台球')!.id}`)[0]!.active).toBe(false);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${pool.id}/active`, { version: pool.version! + 1, active: true, opKey: randomUUID() })).status).toBe(200);
    expect((await ctx.sql<{ active: boolean }[]>`SELECT active FROM service_items WHERE id = ${byName('台球')!.id}`)[0]!.active).toBe(true);

    // 补价：待定价的菜补上售价并改成可以下单，建出收银项目
    const abalone = set.entries.find((e) => e.name === '沙姜炒鸡')!;
    expect(
      (await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${abalone.id}`, { ...abalone, priceMode: 'single', priceCents: 6800, orderable: true, opKey: randomUUID() })).status,
    ).toBe(200);
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM service_items WHERE catalog_managed AND active AND name = '沙姜炒鸡'`)[0]!.n).toBe(1);

    // 第四批：分类核对——能卖的与点单页上的逐个分类对得上；服务费、房间不落库；待定价的不算能卖
    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog/category-checks')).body as PriceCategoryCheck[];
    const check = (name: string, group?: string) => checks.find((c) => c.name === name && (!group || c.group === group))!;
    // 门票不落库（8.1.34：按「门票」票种结账），和服务费、房间一样不算点单页上的项目
    expect(check('门票')).toMatchObject({ code: 'store.ticket', entries: 4, sellable: 0, items: null });
    expect(check('服务费')).toMatchObject({ entries: 1, sellable: 0, items: null });
    expect(check('spa房')).toMatchObject({ items: null });
    expect(check('中式零点', '2楼零点')).toMatchObject({ entries: 2, sellable: 1, items: 1 });
    expect(checks.filter((c) => c.items !== null && c.items !== c.sellable)).toEqual([]);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/price-catalog/category-checks')).status).toBe(403);
    // 导出：六张表各一张工作表，一行一项（第一行表头）
    const exported = await ctx.app.inject({ method: 'GET', url: `/api/admin/price-catalog/sets/${draft.id}/export`, headers: { cookie: ctx.owner } });
    expect(exported.statusCode).toBe(200);
    const book = readXlsx(exported.rawPayload);
    expect(book.sheets.map((sh) => sh.name)).toEqual(['门店价格', '娱乐价格', '房间价格', '零点菜品价格', '按摩及助浴价格']);
    expect(book.sheets.find((sh) => sh.name === '按摩及助浴价格')!.rows.size).toBe(1 + 10);

    // 已开的单照旧显示原名称、原价
    const [line] = await ctx.sql<{ name: string; unitPrice: number }[]>`SELECT name, unit_price FROM bill_lines WHERE item_id = ${ticket.id}`;
    expect(line).toMatchObject({ name: '早餐', unitPrice: 9900 });
  });

  it('PC28：门店原有的同名收银项目对上以后补齐设置（需要技师、时长、专业 / 优选两档、出品档口），房态中心登记与点单页看得到；别的门店定了本店价的档留着；没有档口时分类核对写明原因', async () => {
    const activateNew = async (title: string) => {
      const file = workbook();
      const p = (await preview(file)).body as PriceImportPreview & { digest: string };
      const draft = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: `${title}.xlsx`, xlsxBase64: file, previewDigest: p.digest, title, opKey: randomUUID() }))
        .body as PriceCatalogSet;
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/activate', { opKey: randomUUID(), draftId: draft.id, countReason: '合成的演练表' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    const tiers = async (id: number) =>
      Object.fromEntries((await ctx.sql<{ tier: string; price: number }[]>`SELECT tier, price FROM service_item_prices WHERE item_id = ${id} ORDER BY tier`).map((r) => [r.tier, Number(r.price)]));
    // 正式服的样子：门店原来就有同名的收银项目（以前录的），没标需要技师、只有标准价、菜品没挂档口；先也没有在用的出品档口
    await ctx.sql`DELETE FROM price_catalog_links`;
    await ctx.sql`UPDATE service_items SET active = false, catalog_managed = false, catalog_key = NULL`;
    const stations = (await ctx.sql<{ id: number }[]>`UPDATE kitchen_stations SET active = false WHERE active RETURNING id`).map((r) => Number(r.id));
    const legacy = async (body: Record<string, unknown>) => {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', body);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return Number((await ctx.sql<{ id: number }[]>`SELECT id FROM service_items WHERE name = ${body.name as string} AND active ORDER BY id DESC LIMIT 1`)[0]!.id);
    };
    const gufa = await legacy({ name: '古法中式', category: '按摩', price: 45000, technicianRequired: false });
    const porridge = await legacy({ name: '生滚牛肉粥', category: '餐饮', price: 3000 });
    // 另一家店给原有的「伊索抗衰面部护理」的标准档定了本店价：本店换成专业 / 优选时这一档留着，本店价照旧有着落
    const facial = await legacy({ name: '伊索抗衰面部护理', category: '按摩', price: 70000, technicianRequired: true });
    const ocean = await legacy({ name: '海蓝之谜清洁面部护理', category: '按摩', price: 70000, technicianRequired: true });
    const [store2] = await ctx.sql<{ id: number }[]>`INSERT INTO stores (code, name, entity_id) VALUES ('PC28', '二店', 1) RETURNING id`;
    await ctx.sql`INSERT INTO service_item_store_prices (store_id, item_id, tier, price, updated_by) VALUES (${store2!.id}, ${facial}, 'standard', 72000, 1)`;
    // 切换前按「标准」档开出的钟（价格不跟技师等级）：切换后标准档去掉了，加钟照样能加，按专业档（价目表把专业价写在标准档上）
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true, requireTechnician: false, tierByGrade: false })).status).toBe(200);
    const techRes = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: 'Q28', name: '合成技师', gender: 'female', grade: 'standard' });
    const techId = (techRes.body.technicians as { id: number; techNo: string }[]).find((t) => t.techNo === 'Q28')!.id;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${techId}/state`, { action: 'sign_in' })).status).toBe(200);
    await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'Q', from: 1, to: 1, width: 3, zone: 'female' });
    const qVisit = (await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'Q001', zone: 'female' }] })).body.visits[0].id as number;
    const dispatched = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', {
      clientKey: randomUUID(),
      visitId: qVisit,
      itemId: ocean,
      tier: 'standard',
      quantity: 1,
      expectedTotal: 70000,
      technicianId: techId,
      callType: 'designated',
      startNow: true,
    });
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    const sessionId = (dispatched.body.sessions as { id: number; technicianId: number }[]).find((x) => x.technicianId === techId)!.id;
    // 切换前加的一钟（标准档）没收到结果：切换以后原样重提，认得出是同一笔、不再加
    const before = { clientKey: randomUUID(), quantity: 1, expectedTotal: 70000 };
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${sessionId}/extend`, before)).status).toBe(200);
    await activateNew('原有同名·没有档口');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${sessionId}/extend`, before)).status).toBe(200);
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bill_lines WHERE session_id = ${sessionId} AND status = 'active'`)[0]!.n).toBe(2);
    const ext = await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${sessionId}/extend`, { clientKey: randomUUID(), quantity: 1, expectedTotal: 80000 });
    expect(ext.status, JSON.stringify(ext.body)).toBe(200);
    const extLines = await ctx.sql<{ tier: string; unitPrice: number }[]>`SELECT tier, unit_price FROM bill_lines WHERE session_id = ${sessionId} AND status = 'active' ORDER BY id`;
    expect(extLines).toEqual([
      { tier: 'standard', unitPrice: 70000 },
      { tier: 'standard', unitPrice: 70000 },
      { tier: 'professional', unitPrice: 80000 },
    ]);

    // 没有档口：粥对上了原有的项目但上不了点单页，别的菜建不了——分类核对逐项写明
    let checks = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog/category-checks')).body as PriceCategoryCheck[];
    const congee = checks.find((c) => c.name === '生滚粥')!;
    expect(congee).toMatchObject({ sellable: 2, items: 0 });
    expect(congee.hidden.map((h) => h.name).sort()).toEqual(['生滚牛肉粥', '皮蛋瘦肉粥']);
    expect(congee.hidden.every((h) => /档口/.test(h.reason))).toBe(true);
    // 按摩的原有项目已经补好：标了需要技师、时长照价目表、专业 / 优选两档（原来的标准档去掉），没有新建一个
    const [g] = await ctx.sql<{ technicianRequired: boolean; durationMinutes: number | null; catalogManaged: boolean; code: string }[]>`
      SELECT technician_required, duration_minutes, catalog_managed, catalog_category_code AS code FROM service_items WHERE id = ${gufa}`;
    expect(g).toMatchObject({ technicianRequired: true, durationMinutes: 80, catalogManaged: false, code: 'massage.01' });
    expect(await tiers(gufa)).toEqual({ premium: 59900, professional: 49900 });
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM service_items WHERE name = '古法中式' AND active`)[0]!.n).toBe(1);
    expect(checks.find((c) => c.code === 'massage.01')).toMatchObject({ items: 2, hidden: [] });
    expect(await tiers(facial)).toEqual({ premium: 90000, professional: 80000, standard: 80000 });
    expect((await ctx.sql<{ price: number }[]>`SELECT price FROM service_item_store_prices WHERE item_id = ${facial} AND tier = 'standard'`)[0]!.price).toBe(72000);
    // 房态中心登记（康美部）列得出它，价格是「专业价 / 资深价」两档
    let catalog = (await api(ctx.app, ctx.clerk, 'GET', '/api/catalog')).body as Catalog;
    const g2 = catalog.items.find((i) => i.id === gufa)!;
    expect(g2).toMatchObject({ technicianRequired: true, durationMinutes: 80 });
    expect(g2.prices.map((p) => p.tier)).toEqual(['professional', 'premium']);
    expect(catalog.items.filter((i) => i.technicianRequired && !ROOM_SERVICE_EXCLUDED_CATEGORIES.includes(i.catalogCategory?.code ?? '')).map((i) => i.id)).toContain(gufa);

    // 建了档口以后再切换生效一次：粥挂上档口、归到餐厅，别的菜也建出来；分类核对都对得上
    await ctx.sql`UPDATE kitchen_stations SET active = true WHERE id IN ${ctx.sql(stations.length ? stations : [0])}`;
    if (!stations.length) await ctx.sql`INSERT INTO kitchen_stations (name) VALUES ('演练热菜')`;
    await activateNew('原有同名·有档口');
    // 只挂上档口；点单分区没写的照旧按类别归到默认分区（「餐饮」→ 餐厅），不改
    const [pr] = await ctx.sql<{ stationId: number | null; diningOutlet: string | null; catalogManaged: boolean }[]>`
      SELECT station_id, dining_outlet, catalog_managed FROM service_items WHERE id = ${porridge}`;
    expect(pr).toMatchObject({ diningOutlet: null, catalogManaged: false });
    expect(pr!.stationId).not.toBeNull();
    const menu = (await api(ctx.app, ctx.owner, 'GET', '/api/dining/menu')).body as DiningMenu;
    expect(menu.dishes.find((d) => d.id === porridge)).toMatchObject({ outlet: 'restaurant', catalogCategory: { name: '生滚粥' } });
    checks = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog/category-checks')).body as PriceCategoryCheck[];
    expect(checks.filter((c) => c.items !== null && c.items !== c.sellable)).toEqual([]);
    expect(checks.every((c) => c.hidden.length === 0)).toBe(true);
    // 价目表里把粥改成不可下单：原有的收银项目不跟着停用、还在点单页上——分类核对查得出来、写明
    const overview = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog')).body as { active: { id: number } };
    const current = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${overview.active.id}`)).body as PriceCatalogSet;
    const beef = current.entries.find((e) => e.name === '生滚牛肉粥')!;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${beef.id}`, { ...beef, orderable: false, opKey: randomUUID() })).status).toBe(200);
    checks = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog/category-checks')).body as PriceCategoryCheck[];
    const congee2 = checks.find((c) => c.name === '生滚粥')!;
    expect(congee2).toMatchObject({ sellable: 1, items: 2 });
    expect(congee2.hidden).toEqual([{ name: '生滚牛肉粥', reason: expect.stringMatching(/不能卖.*还在点单页上/) }]);
    // 再把这一项在价目表里停用：原有的收银项目照样还在点单页上，分类核对照样查得出（停用的项不在「在用」里，按对接的收银项目数）
    const set3 = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/price-catalog/sets/${overview.active.id}`)).body as PriceCatalogSet;
    const beef3 = set3.entries.find((e) => e.name === '生滚牛肉粥')!;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/admin/price-catalog/entries/${beef3.id}/active`, { version: beef3.version, active: false, opKey: randomUUID() })).status).toBe(200);
    checks = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/price-catalog/category-checks')).body as PriceCategoryCheck[];
    const congee3 = checks.find((c) => c.name === '生滚粥')!;
    expect(congee3).toMatchObject({ entries: 1, sellable: 1, items: 2 });
    expect(congee3.hidden).toEqual([{ name: '生滚牛肉粥', reason: expect.stringMatching(/停用.*还在点单页上/) }]);
    // 补齐设置记了审计，写明哪几个、改了什么；名称、类别不动
    const audit = await ctx.sql<{ detail: { label: string; items: { itemId: number; changes: string[] }[] } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'price_catalog' AND detail->>'action' = 'fit_items' ORDER BY id`;
    const changesOf = (id: number) => audit.flatMap((a) => a.detail.items.filter((i) => i.itemId === id).map((i) => i.changes));
    expect(changesOf(gufa)).toEqual([['标为需要技师', '时长 — → 80 分钟']]); // 补过一次，第二次切换不再改
    expect(changesOf(porridge)).toEqual([['挂上出品档口']]);
    expect(audit.at(-1)!.detail.label).toMatch(/原有的收银项目补齐了设置/);
    catalog = (await api(ctx.app, ctx.clerk, 'GET', '/api/catalog')).body as Catalog;
    expect(catalog.items.find((i) => i.id === porridge)).toMatchObject({ name: '生滚牛肉粥', category: '餐饮' });
    expect(catalog.items.find((i) => i.id === gufa)).toMatchObject({ name: '古法中式', category: '按摩' });
  });
});
