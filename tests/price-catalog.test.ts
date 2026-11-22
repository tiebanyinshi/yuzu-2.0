// 价目表录入 第一批（docs/PRICE_CATALOG.md，PC1 起；迁移 230）：六张表导入成草稿——价格字段口径（以分存、带单位的写法拆成
// 价格 / 时长 / 加钟 / 封顶，双价 / 单价 / 无价格三种形态、空值不存 0、服务费按比例）、逐行校验带工作表 / 行号 / 字段 / 原因、
// 条数对照、草稿替换、权限、导入模板。用合成的六张表（照《价目表 1119》的版式与合并格），不放门店的原表。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PriceCatalogEntry, PriceCatalogOverview, PriceCatalogSet, PriceImportPreview } from '../src/shared/price-catalog';
import { buildWorkbook, type WbSheet } from '../src/server/lib/xlsx';
import { readXlsx } from '../src/server/lib/xlsx-read';
import { minutesOf, roomNumbersOf, windowOf, yuanToCents } from '../src/server/modules/price-catalog/parse';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
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
        ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价'],
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
        "按摩及助浴价格|2|时长|时长格式不支持：「一个半小时」（写 60min、60分钟、60'）",
        expect.stringMatching(/^按摩及助浴价格\|3\|项目名称\|名称重复：「古法中式」在「康疗」第 2 行已经有了/),
        expect.stringMatching(/^按摩及助浴价格\|4\|板块分类\|板块「足疗」不存在/),
        '按摩及助浴价格|5|专业价|价格为空',
        '娱乐价格||工作表|少了「娱乐价格」这张表',
      ]),
    );
    expect(p.errorCount).toBe(errors.length);
    // 有问题整份不导
    const refused = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: 'x.xlsx', xlsxBase64: bad, previewDigest: 'a'.repeat(64) });
    expect(refused.status).toBe(422);
  });

  it('导入成草稿：条目落库、条数对照；再导一份替换原来的草稿；生效的价目表不受影响；只有能管理项目的能导', async () => {
    const file = workbook();
    const p = (await preview(file)).body as PriceImportPreview & { digest: string };
    // 换了文件（摘要对不上）不导
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: 'a.xlsx', xlsxBase64: file, previewDigest: 'b'.repeat(64) })).body.error.code).toBe('IMPORT_STALE');
    const done = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: '汤崎宝安全品类价目表1119.xlsx', xlsxBase64: file, previewDigest: p.digest });
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
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/admin/price-catalog/import', { fileName: '第二版.xlsx', xlsxBase64: file, previewDigest: p.digest, title: '第二版' });
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
});
