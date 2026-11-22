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
  priceChangeLines,
  priceEntryProblems,
  priceText,
  windowText,
  type PriceCatalogEntry,
  type PriceCatalogOverview,
  type PriceCatalogSet,
  type PriceChange,
  type PriceImportPreview,
} from '../src/shared/price-catalog';
import { buildWorkbook, type WbSheet } from '../src/server/lib/xlsx';
import { readXlsx } from '../src/server/lib/xlsx-read';
import { minutesOf, roomNumbersOf, windowOf, yuanToCents } from '../src/server/modules/price-catalog/parse';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
/** 用例里按名字取固定的操作编号（服务端要 UUID） */
const OP: Record<string, string> = new Proxy({} as Record<string, string>, { get: (t, k: string) => (t[k] ??= randomUUID()) });
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

type Row = (string | number | null)[];
const sheet = (name: string, rows: Row[], merges: string[] = []): WbSheet => ({ name, widths: [10], rows: rows.map((cells) => ({ cells })), merges });

/** 照《价目表 1119》的六张表：门店 9 + 服务费、娱乐 8、房间 9、零点（四个餐段各几道）、按摩（9 个板块各一项以上） */
function workbook(over: Partial<Record<string, WbSheet>> = {}): string {
  const sheets: WbSheet[] = [
    sheet(
      '门店价格',
      [
        ['汤崎（宝安池里）'],
        ['类型', '项目', '价格', '备注', '时间'],
        ['门票', '12H', 499, '不含餐', '从领手牌起开始计时\n超时30分钟自动跳档'],
        [null, '12H', 699, '含3餐'],
        [null, '24H', 699, '不含餐'],
        [null, '24H', 899, '含3餐'],
        ['夜间票', ' 21点-次日11点', 599, '早餐+夜宵', '11点未离店，按实际门票时间计费'],
        ['餐票', '早餐', 99, '零售', '7：30--10：00'],
        [null, '午餐', 199, null, '11：30--14：00'],
        [null, '晚餐', 299, null, '17：30--21：00'],
        [null, '夜宵', 99, null, '23：30--2：00'],
        ['服务费', '服务费', 0.1, '全场消费加10%'],
      ],
      ['A1:E1', 'A3:A6', 'E3:E6', 'A8:A11', 'D8:D11'],
    ),
    sheet('娱乐价格', [
      ['汤崎（宝安池里）'],
      ['类型', '数量', '价格', '备注'],
      ['畅玩卷', null, 99, '新生及娱乐'],
      ['PS5游戏机', 17, '39/2h', '加钟/19.9'],
      ['台球', 4, '39/2h', '加钟/19.9'],
      ['斯诺克', 1, '99/2h', '加钟/59.9'],
      ['乒乓球', 1, '39/2h', '加钟/19.9'],
      ['手动足球', 2, '39/2h', '加钟/19.9'],
      ['冰壶桌', 1, '39/2h', '加钟/19.9'],
      ['大厅电竞', 18, '39/2h', '加钟/19.9'],
    ]),
    sheet(
      '房间价格',
      [
        ['房型', '总数', '收费参考', null, '备注'],
        ['spa房', '35间', '399/2H起开', '超时199/H\n999封顶过夜', 'S301-S335，共计35间房'],
        ['按摩房', '30间', '299/2H起开', '超时199/H\n499封顶过夜', 'M301-M330'],
        ['足浴情侣房', '6间', '299/2H起开', '超时199/H\n599封顶过夜', 'F301-306'],
        ['足浴棋牌房', '6间', '399/2H起开', '超时199/H\n999封顶过夜', 'F308-313'],
        ['足浴投影房', '2间', '299/2H起开', '超时199/H\n599封顶过夜', 'F315-316 '],
        ['棋牌房', '5间', '299/2H起开', '超时199/H\n699/8H\n999封顶', 'Q301 Q302 Q303 Q305 Q306'],
        ['客房', '7间', '小房间 599/晚  \n大房间 699/晚 ', '399/3小时 \n499/3小时 ', 'R01-R07 '],
        ['轰趴房', '9间', '6小时：999\n12小时 ：1599', null, '  70平（H203-209) 4人位', '开瓶费：白酒800元/支'],
        [null, null, '6小时：899\n12小时 ：1299', null, '40平（H210)'],
        [null, null, '6小时：2399\n12小时 ：2000', '包天：5000', '100平（H202) 5人位'],
        [null, null, '6小时：2999\n12小时 ：2599', '包天：6000', '150平（H201) 5人位'],
        [
          '餐饮包房',
          '5间',
          '688元/位（只限餐饮）\n988元/位（只限餐饮）\n1288元/位（只限餐饮）\n低销：6888元起\n次日11：00退房，超出按照588元/小时收费。',
          '或者套餐低消',
          '2楼：V999、V888 4楼：V777、V666、V555',
        ],
      ],
      ['A9:A12', 'B9:B12', 'F9:F12'],
    ),
    sheet(
      '零点菜品价格',
      [
        ['2楼餐厅零点菜品'],
        ['序号', '菜品分类', '菜品名称', '售价', '单位', '成本', '成本率', '标签'],
        [1, '中餐零点', '蚝皇扣鲍鱼', null, '位'],
        [2, null, '沙姜炒鸡', null, '份'],
        ['早餐自助零点菜品'],
        ['序号', '菜品分类', '菜品名称', '售价', '单位'],
        [1, '生滚粥', '生滚牛肉粥', 38, '份'],
        [2, null, '皮蛋瘦肉粥', 38, '份'],
        ['午餐自助零点菜品'],
        ['序号', '菜品分类', '菜品名称', '售价', '单位'],
        [1, '中式零点', '玻璃脆皮妙龄乳鸽', 168, '位'],
        ['晚餐自助零点菜品'],
        ['序号', '菜品分类', '菜品名称', '售价', '单位'],
        [1, '中式零点', '蚝皇扣鲍鱼', 238, '份'],
      ],
      ['A1:H1', 'B3:B4', 'A5:H5', 'A9:H9', 'A12:H12'],
    ),
    sheet(
      '按摩及助浴价格',
      [
        ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点', '核心定位', '思路'],
        ['康疗', 1, '古法中式', '房间', '80min', 499, 599, '久坐办公', '1.闻香礼3min', '以经络穴位为核心', '内部', '内部'],
        [null, 2, '瑜伽泰式', '房间', '90min', 599, 699],
        ['中医', 10, '十二经络疏通调理', '房间', '80min', 700, null],
        ['面护', 23, '伊索抗衰面部护理', '房间', '80分钟', 800, 900],
        [null, 24, '海蓝之谜清洁面部护理', '房间', "60'", 800, 900],
        ['大堂按摩', 40, '精致修脚', '大堂/房间', '45min', 300, '—'],
        ['助浴', 53, '泰式私汤药浴(女宾)', '浴区', '30min', 300, null],
        [null, 60, '茱莉蔻柑橘护理', '浴区', '45min', 400, '男/女'],
        [null, 59, '茱莉蔻玫瑰柔肤护理', '浴区', '45min', 400, '女'],
        ['护理', 74, '手部美甲精修', null, null, 200, null],
      ],
      ['A2:A3'],
    ),
    sheet('储值政策', [['储值政策'], ['同步大客部门  建议两店通用']]),
  ].map((s) => over[s.name] ?? s);
  return buildWorkbook(sheets).toString('base64');
}

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
    expect(find(p, '门票 12H 不含餐')).toMatchObject({ kind: 'ticket', priceMode: 'single', priceCents: 49900, durationMinutes: 720, includesMeal: false });
    expect(find(p, '门票 24H 含餐')).toMatchObject({ priceCents: 89900, durationMinutes: 1440, includesMeal: true });
    expect(find(p, '夜间票')).toMatchObject({ kind: 'night_ticket', priceCents: 59900, windowStart: 1260, windowEnd: 660 });
    expect(find(p, '早餐餐票')).toMatchObject({ kind: 'meal_ticket', priceCents: 9900, windowStart: 450, windowEnd: 600 });
    expect(find(p, '夜宵餐票')).toMatchObject({ windowStart: 1410, windowEnd: 120 });
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
    expect(entryFacts(find(p, '门票 24H 含餐'), yuan)).toEqual(['24 小时 · 含餐']);
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
    const body = { ...item, extraPriceCents: (item.extraPriceCents ?? 1000) + 100, opKey };
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
});
