// 价目表录入（店主 2026-11-22《汤崎宝安全品类价目表录入系统需求说明》，docs/PRICE_CATALOG.md，PC1 起）：
// 《汤崎宝安全品类价目表 1119》六张表录成一份价目表数据集。价格以分存整数；三种价格形态——双价（专业价 / 资深价）、
// 单价、无价格（待定价或免费，空值不存 0、页面不显示「0 元」）；服务费按比例存。时长一律分钟。

/** 六张表（储值政策本次不录入，只记下那一句） */
export const PRICE_SHEETS = ['store', 'entertainment', 'room', 'dish', 'massage'] as const;
export type PriceSheet = (typeof PRICE_SHEETS)[number];
/** 工作表名（导入、导出、报错都用表格里的原名） */
export const PRICE_SHEET_NAMES: Record<PriceSheet, string> = {
  store: '门店价格',
  entertainment: '娱乐价格',
  room: '房间价格',
  dish: '零点菜品价格',
  massage: '按摩及助浴价格',
};
export const STORED_VALUE_SHEET_NAME = '储值政策';

/** 每张表应有的条数（需求说明第二节，录完逐项核对；门店价格不含服务费那一条规则） */
export const PRICE_EXPECTED_COUNTS: Record<PriceSheet, number> = { store: 9, entertainment: 8, room: 9, dish: 131, massage: 67 };
export const PRICE_EXPECTED_TOTAL = 224;

/** 按摩及助浴的 9 个板块与项数（原始编号 1–76，编号 43 空缺，护理自 74 起） */
export const MASSAGE_SECTIONS = ['康疗', 'SPA', '中医', '面护', '头疗房', '大堂按摩', '加项', '助浴', '护理'] as const;
export const MASSAGE_SECTION_COUNTS: Record<(typeof MASSAGE_SECTIONS)[number], number> = {
  康疗: 4,
  SPA: 5,
  中医: 6,
  面护: 16,
  头疗房: 5,
  大堂按摩: 11,
  加项: 3,
  助浴: 14,
  护理: 3,
};

/** 零点菜品的四个餐段（表里的分段标题 → 餐段）与项数 */
export const DISH_SECTIONS = ['2楼零点', '早餐', '午餐', '晚餐'] as const;
export const DISH_SECTION_COUNTS: Record<(typeof DISH_SECTIONS)[number], number> = { '2楼零点': 30, 早餐: 27, 午餐: 36, 晚餐: 38 };

export type PriceKind = 'ticket' | 'night_ticket' | 'meal_ticket' | 'service_fee' | 'play_pass' | 'entertainment' | 'room_type' | 'party_room' | 'dining_room' | 'dish' | 'massage';

/** 价格形态：双价（专业价 + 资深价）、单价、无价格（待定价或免费）、比例（服务费） */
export type PriceMode = 'dual' | 'single' | 'none' | 'rate';

/** 适用房型：房间 / 大堂 / 浴区 */
export type PriceVenue = 'room' | 'lobby' | 'bath';
export type PriceGender = 'female' | 'male' | 'any';

/** 一项里还分的档（轰趴房按面积、客房大小房与时段、餐饮包房的位价、棋牌房 8H 价……） */
export interface PriceVariant {
  /** 档名：「70平」「小房间」「8H」「位价」 */
  label: string;
  /** 这一档的价格（分）；没有的为 null */
  priceCents: number | null;
  /** 含多少分钟（6 小时 = 360；包天、过夜为 null） */
  minutes: number | null;
  /** 计价单位（晚、位、包天……） */
  unit: string;
  /** 这一档的房号（轰趴房 70 平是 H203–H209） */
  roomNumbers?: string[];
  /** 几人位 */
  seats?: number;
  note?: string;
}

export interface PriceCatalogEntry {
  id?: number;
  /** 版本号（第三批）：改价、停用带着读到的版本，别人先改了就拒绝；导入预览里的条目没有 */
  version?: number;
  sheet: PriceSheet;
  kind: PriceKind;
  section: string;
  category: string;
  code: string;
  name: string;
  priceMode: PriceMode;
  /** 单价，或双价的专业价（分） */
  priceCents: number | null;
  /** 双价的资深价（分） */
  price2Cents: number | null;
  /** 服务费比例（万分之几，10% = 1000） */
  rateBp: number | null;
  unit: string;
  durationMinutes: number | null;
  /** 加钟价（娱乐）/ 超时单价（房间）及每次多少分钟 */
  extraPriceCents: number | null;
  extraMinutes: number | null;
  capCents: number | null;
  /** 台位数 / 房型总间数 */
  unitsCount: number | null;
  roomNumbers: string[];
  /** 时段：分钟（0–1439），跨零点时结束小于开始 */
  windowStart: number | null;
  windowEnd: number | null;
  includesMeal: boolean | null;
  venues: PriceVenue[];
  gender: PriceGender | null;
  audience: string;
  content: string;
  highlight: string;
  note: string;
  variants: PriceVariant[];
  orderable: boolean;
  active: boolean;
  /** 表格里的行号 */
  sourceRow: number | null;
  sortOrder: number;
}

export interface PriceImportIssue {
  /** 工作表原名 */
  sheet: string;
  row: number | null;
  field: string;
  message: string;
  /** error 挡导入；warning 只提醒（表里的数自相矛盾、待定价之类） */
  level: 'error' | 'warning';
}

/** 条数对照：每张表系统条数 / 表格应有条数；按摩及助浴另分板块、零点菜品另分餐段 */
export interface PriceCountCheck {
  sheet: PriceSheet;
  name: string;
  expected: number;
  actual: number;
  parts: { name: string; expected: number; actual: number }[];
}

export interface PriceImportPreview {
  fileName: string;
  sha256: string;
  entries: PriceCatalogEntry[];
  issues: PriceImportIssue[];
  errorCount: number;
  warningCount: number;
  counts: PriceCountCheck[];
  total: { expected: number; actual: number };
  /** 不录入、只记下来的（储值政策那一句） */
  notes: Record<string, string>;
}

export interface PriceCatalogSetSummary {
  id: number;
  status: 'draft' | 'active' | 'retired';
  title: string;
  fileName: string | null;
  createdAt: string;
  createdByName: string;
  activatedAt: string | null;
  activatedByName: string | null;
  retiredAt: string | null;
  counts: PriceCountCheck[];
  total: { expected: number; actual: number };
  notes: Record<string, string>;
}

export interface PriceCatalogSet extends PriceCatalogSetSummary {
  entries: PriceCatalogEntry[];
}

export interface PriceCatalogOverview {
  active: PriceCatalogSetSummary | null;
  draft: PriceCatalogSetSummary | null;
  /** 上一版：最近一次被换下来的那份（整体回滚回到它） */
  previous: PriceCatalogSetSummary | null;
}

/** 条数对照（导入预览、数据集都用）：停用的不算 */
export function priceCounts(entries: Pick<PriceCatalogEntry, 'sheet' | 'kind' | 'section' | 'active'>[]): { counts: PriceCountCheck[]; total: { expected: number; actual: number } } {
  const live = entries.filter((e) => e.active && e.kind !== 'service_fee');
  const counts = PRICE_SHEETS.map((sheet) => {
    const mine = live.filter((e) => e.sheet === sheet);
    const parts =
      sheet === 'massage'
        ? MASSAGE_SECTIONS.map((s) => ({ name: s, expected: MASSAGE_SECTION_COUNTS[s], actual: mine.filter((e) => e.section === s).length }))
        : sheet === 'dish'
          ? DISH_SECTIONS.map((s) => ({ name: s, expected: DISH_SECTION_COUNTS[s], actual: mine.filter((e) => e.section === s).length }))
          : [];
    return { sheet, name: PRICE_SHEET_NAMES[sheet], expected: PRICE_EXPECTED_COUNTS[sheet], actual: mine.length, parts };
  });
  return { counts, total: { expected: PRICE_EXPECTED_TOTAL, actual: counts.reduce((n, c) => n + c.actual, 0) } };
}

// ───────────────────────── 列表与搜索（第二批） ─────────────────────────

export const PRICE_KIND_LABELS: Record<PriceKind, string> = {
  ticket: '门票',
  night_ticket: '夜间票',
  meal_ticket: '餐票',
  service_fee: '服务费',
  play_pass: '畅玩卷',
  entertainment: '娱乐项目',
  room_type: '房型',
  party_room: '轰趴房',
  dining_room: '餐饮包房',
  dish: '菜品',
  massage: '按摩及助浴',
};
export const PRICE_VENUE_LABELS: Record<PriceVenue, string> = { room: '房间', lobby: '大堂', bath: '浴区' };
export const PRICE_GENDER_LABELS: Record<PriceGender, string> = { female: '女', male: '男', any: '男 / 女' };

/** 页面上显示价格：无价格写「待定价」，不写 0 元；服务费写百分比 */
export function priceText(e: Pick<PriceCatalogEntry, 'priceMode' | 'priceCents' | 'price2Cents' | 'rateBp'>, yuan: (cents: number) => string): string {
  if (e.priceMode === 'rate') return `${(e.rateBp ?? 0) / 100}%`;
  if (e.priceMode === 'none' || e.priceCents === null) return '待定价';
  if (e.priceMode === 'dual' && e.price2Cents !== null) return `专业 ${yuan(e.priceCents)} / 资深 ${yuan(e.price2Cents)}`;
  return yuan(e.priceCents);
}

const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
/** 时段：「7:30–10:00」，跨零点写「次日」 */
export const windowText = (start: number | null, end: number | null): string => (start === null || end === null ? '' : `${hm(start)}–${end < start ? '次日' : ''}${hm(end)}`);
/** 时长：「80 分钟」，整小时写「2 小时」 */
export const minutesText = (m: number | null): string => (m === null ? '' : m % 60 === 0 && m >= 60 ? `${m / 60} 小时` : `${m} 分钟`);

/** 一项的「规格」一行：时长 / 时段 / 加钟 / 超时 / 封顶 / 台位 / 房号 / 适用 */
export function entryFacts(e: PriceCatalogEntry, yuan: (cents: number) => string): string[] {
  const facts: string[] = [];
  if (e.kind === 'ticket' && e.durationMinutes) facts.push(`${minutesText(e.durationMinutes)}${e.includesMeal ? ' · 含餐' : ' · 不含餐'}`);
  else if (e.durationMinutes) facts.push(e.sheet === 'massage' ? `${e.durationMinutes} 分钟` : `含 ${minutesText(e.durationMinutes)}`);
  const w = windowText(e.windowStart, e.windowEnd);
  if (w) facts.push(w);
  if (e.extraPriceCents !== null) facts.push(`${e.sheet === 'entertainment' ? '加钟' : '超时'} ${yuan(e.extraPriceCents)}/${minutesText(e.extraMinutes ?? 60)}`);
  if (e.capCents !== null) facts.push(`封顶 ${yuan(e.capCents)}`);
  if (e.unitsCount !== null) facts.push(e.sheet === 'entertainment' ? `${e.unitsCount} 台` : `${e.unitsCount} 间`);
  if (e.roomNumbers.length) facts.push(e.roomNumbers.length > 4 ? `${e.roomNumbers[0]}–${e.roomNumbers[e.roomNumbers.length - 1]}（${e.roomNumbers.length} 个）` : e.roomNumbers.join('、'));
  if (e.venues.length) facts.push(e.venues.map((v) => PRICE_VENUE_LABELS[v]).join(' / '));
  if (e.gender) facts.push(`适用 ${PRICE_GENDER_LABELS[e.gender]}`);
  return facts;
}

/** 搜索：名称、编号、分类、板块 / 餐段、房号都能搜（不分大小写、不管空格） */
export function matchesPriceSearch(e: PriceCatalogEntry, q: string): boolean {
  const t = q.replace(/\s+/g, '').toLowerCase();
  if (!t) return true;
  return [e.name, e.code, e.category, e.section, ...e.roomNumbers].some((s) => s.replace(/\s+/g, '').toLowerCase().includes(t));
}

/** 草稿与生效对比用的键：同一张表、同一个板块 / 餐段、同一个分类里同名的算同一项 */
export const priceEntryKey = (e: Pick<PriceCatalogEntry, 'sheet' | 'section' | 'category' | 'name'>) => `${e.sheet}|${e.section}|${e.category}|${e.name}`;

export interface PriceDiff {
  key: string;
  change: 'added' | 'removed' | 'changed';
  draft: PriceCatalogEntry | null;
  active: PriceCatalogEntry | null;
}
/** 草稿比生效多了、少了、改了价格（价格形态、两个价、比例、加钟 / 超时、封顶）的那几项 */
export function diffPriceCatalogs(draft: PriceCatalogEntry[], active: PriceCatalogEntry[]): PriceDiff[] {
  // 同名的可以有一项在用、几项已停用（停用的不算重名）：对比时在用的那项优先，停用的历史项不能把它盖掉
  const byKey = (list: PriceCatalogEntry[]) => {
    const m = new Map<string, PriceCatalogEntry>();
    for (const e of list) {
      const key = priceEntryKey(e);
      const had = m.get(key);
      if (!had || (!had.active && e.active)) m.set(key, e);
    }
    return m;
  };
  const a = byKey(active);
  const d = byKey(draft);
  const sig = (e: PriceCatalogEntry) => JSON.stringify([priceSignature(e), e.active, e.orderable]);
  const out: PriceDiff[] = [];
  for (const [key, e] of d) {
    const old = a.get(key);
    if (!old) out.push({ key, change: 'added', draft: e, active: null });
    else if (sig(old) !== sig(e)) out.push({ key, change: 'changed', draft: e, active: old });
  }
  for (const [key, e] of a) if (!d.has(key)) out.push({ key, change: 'removed', draft: null, active: e });
  return out;
}

// ───────────────────────── 编辑与校验（第三批） ─────────────────────────

/** 每张表能新增哪几种（服务费只有一条规则，不新增） */
export const PRICE_SHEET_KINDS: Record<PriceSheet, PriceKind[]> = {
  store: ['ticket', 'night_ticket', 'meal_ticket'],
  entertainment: ['entertainment', 'play_pass'],
  room: ['room_type', 'party_room', 'dining_room'],
  dish: ['dish'],
  massage: ['massage'],
};
const KIND_SHEET: Record<PriceKind, PriceSheet> = {
  ticket: 'store',
  night_ticket: 'store',
  meal_ticket: 'store',
  service_fee: 'store',
  play_pass: 'entertainment',
  entertainment: 'entertainment',
  room_type: 'room',
  party_room: 'room',
  dining_room: 'room',
  dish: 'dish',
  massage: 'massage',
};

/**
 * 主价格由分档推出来的几种（与导入时同一个口径）：轰趴房 = 各档最低价；餐饮包房 = 位价里最低的；
 * 客房（有「晚」档）= 过夜价里最低的。其余的（棋牌房的 8H 档等）主价格自己填，返回 undefined。
 * 改了分档价时主价格跟着变，不会出现列表写 ¥599、分档里却已经没有 599 的情况。
 */
export function derivedMainPrice(e: Pick<PriceCatalogEntry, 'kind' | 'variants'>): number | null | undefined {
  const pick = (unit?: string) => {
    const prices = e.variants.filter((v) => unit === undefined || v.unit === unit).map((v) => v.priceCents);
    const ok = prices.filter((v): v is number => v !== null);
    return ok.reduce<number | null>((m, v) => (m === null || v < m ? v : m), null);
  };
  if (e.kind === 'party_room' && e.variants.length) return pick();
  if (e.kind === 'dining_room' && e.variants.some((v) => v.unit === '位')) return pick('位');
  if (e.kind === 'room_type' && e.variants.some((v) => v.unit === '晚')) return pick('晚');
  return undefined;
}

/** 写入前把推出来的主价格填上（单价形态） */
export function withDerivedPrice(e: PriceCatalogEntry): PriceCatalogEntry {
  const d = derivedMainPrice(e);
  if (d === undefined || e.priceMode === 'none') return e;
  return { ...e, priceMode: 'single', priceCents: d, price2Cents: null };
}

/** 一项（或一档）最多几个房号（导入、页面编辑、服务端校验同一个上限；原表最多 39 个） */
export const PRICE_ROOM_NUMBERS_MAX = 300;

/** 一项最多几档（导入、页面编辑、服务端校验同一个上限；原表最多 10 档） */
export const PRICE_VARIANTS_MAX = 20;

/** 单价上限：100 万元（分） */
export const PRICE_MAX_CENTS = 100_000_000;

/** 价格有没有变：形态、两个价、比例、计价单位、基础价含的时长、适用时段、是否含餐、加钟 / 超时、封顶、分档（档名、价、时长、单位） */
export const priceSignature = (
  e: Pick<
    PriceCatalogEntry,
    'priceMode' | 'priceCents' | 'price2Cents' | 'rateBp' | 'unit' | 'durationMinutes' | 'windowStart' | 'windowEnd' | 'includesMeal' | 'extraPriceCents' | 'extraMinutes' | 'capCents' | 'variants'
  >,
) =>
  JSON.stringify([
    e.priceMode,
    e.priceCents,
    e.price2Cents,
    e.rateBp,
    // 计价单位（份 → 位，钱数不变也是改了价）
    e.unit,
    // 基础价含多久（娱乐 39 元 2 小时改成 1 小时，钱数不变也是改了价）
    e.durationMinutes,
    // 适用时段、是否含餐（餐票早餐 7:30 改 8:00、门票含餐改不含餐，钱数不变也是改了价）
    e.windowStart,
    e.windowEnd,
    e.includesMeal,
    e.extraPriceCents,
    e.extraMinutes,
    e.capCents,
    e.variants.map((v) => [v.label, v.priceCents, v.minutes, v.unit]),
  ]);

/** 逐项校验（页面提交前、服务端写入前用同一份）：返回问题，空数组为通过。名称重复要查库，在服务端另查 */
export function priceEntryProblems(e: PriceCatalogEntry): string[] {
  const out: string[] = [];
  const amount = (v: number | null, label: string) => {
    if (v !== null && (!Number.isInteger(v) || v <= 0 || v > PRICE_MAX_CENTS)) out.push(`${label}要大于 0、不超过 100 万元`);
  };
  const len = (v: string, max: number, label: string) => {
    if (v.length > max) out.push(`${label}最多 ${max} 个字`);
  };
  if (!e.name.trim()) out.push('请填名称');
  len(e.name, 48, '名称');
  len(e.code, 12, '编号');
  len(e.section, 20, e.sheet === 'dish' ? '餐段' : '板块');
  len(e.category, 20, '分类');
  len(e.unit, 8, '单位');
  len(e.note, 400, '备注');
  len(e.audience, 400, '核心人群');
  len(e.content, 800, '操作内容');
  len(e.highlight, 400, '项目亮点');
  if (KIND_SHEET[e.kind] !== e.sheet) out.push(`「${PRICE_KIND_LABELS[e.kind]}」不属于${PRICE_SHEET_NAMES[e.sheet]}`);
  if (e.sheet === 'massage' && !(MASSAGE_SECTIONS as readonly string[]).includes(e.section)) out.push(`板块不存在：要是 ${MASSAGE_SECTIONS.join('、')} 之一`);
  if (e.sheet === 'dish' && !(DISH_SECTIONS as readonly string[]).includes(e.section)) out.push(`餐段不认识：要是 ${DISH_SECTIONS.join('、')} 之一`);
  if ((e.kind === 'service_fee') !== (e.priceMode === 'rate')) out.push(e.kind === 'service_fee' ? '服务费按比例填' : '只有服务费按比例填');
  if (e.priceMode === 'rate' && (e.rateBp === null || !Number.isInteger(e.rateBp) || e.rateBp < 1 || e.rateBp > 10000)) out.push('比例要在 0.01% 到 100% 之间');
  if (e.priceMode === 'dual' && (e.priceCents === null || e.price2Cents === null)) out.push('双价要填专业价和资深价');
  if (e.priceMode === 'single' && e.priceCents === null) out.push('请填价格；没有价格的选「待定价」');
  if ((e.priceMode === 'none' || e.priceMode === 'rate') && (e.priceCents !== null || e.price2Cents !== null)) out.push('待定价不填价格（空着，不写 0）');
  if (e.priceMode === 'single' && e.price2Cents !== null) out.push('单价只填一个价');
  if (e.priceMode !== 'rate' && e.rateBp !== null) out.push('只有服务费按比例填');
  amount(e.priceCents, e.priceMode === 'dual' ? '专业价' : '价格');
  amount(e.price2Cents, '资深价');
  amount(e.extraPriceCents, e.sheet === 'entertainment' ? '加钟价' : '超时价');
  amount(e.capCents, '封顶价');
  if (e.kind === 'dish' && e.priceMode === 'none' && e.orderable) out.push('待定价的菜不能下单：先填售价，再设为可下单');
  if (e.durationMinutes !== null && (!Number.isInteger(e.durationMinutes) || e.durationMinutes < 1 || e.durationMinutes > 2880)) out.push('时长要在 1 到 2880 分钟之间');
  if (e.extraMinutes !== null && (!Number.isInteger(e.extraMinutes) || e.extraMinutes < 1 || e.extraMinutes > 1440)) out.push('加钟 / 超时每次要在 1 到 1440 分钟之间');
  if (e.extraMinutes !== null && e.extraPriceCents === null) out.push('填了每次多少分钟，也要填加钟 / 超时价');
  if ((e.windowStart === null) !== (e.windowEnd === null)) out.push('时段要填开始和结束');
  for (const w of [e.windowStart, e.windowEnd]) if (w !== null && (!Number.isInteger(w) || w < 0 || w > 1439)) out.push('时段的时刻不对');
  if (e.unitsCount !== null && (!Number.isInteger(e.unitsCount) || e.unitsCount < 0 || e.unitsCount > 999)) out.push('台位 / 间数要在 0 到 999 之间');
  if (e.variants.length > PRICE_VARIANTS_MAX) out.push(`分档最多 ${PRICE_VARIANTS_MAX} 档`);
  if (e.roomNumbers.length > PRICE_ROOM_NUMBERS_MAX || e.variants.some((v) => (v.roomNumbers?.length ?? 0) > PRICE_ROOM_NUMBERS_MAX)) out.push(`房号最多 ${PRICE_ROOM_NUMBERS_MAX} 个`);
  if ([...e.roomNumbers, ...e.variants.flatMap((v) => v.roomNumbers ?? [])].some((n) => n.length > 12)) out.push('房号每个最多 12 个字');
  for (const v of e.variants) {
    if (!v.label.trim() || v.label.length > 20) out.push('分档要有名称（最多 20 个字）');
    amount(v.priceCents, `分档「${v.label}」的价格`);
    if (v.minutes !== null && (!Number.isInteger(v.minutes) || v.minutes < 1 || v.minutes > 2880)) out.push(`分档「${v.label}」的时长不对`);
  }
  return [...new Set(out)];
}

/** 名称重复的键：同一张表、同一个板块 / 餐段、同一个分类里，不分大小写、不管空格 */
export const priceNameKey = (e: Pick<PriceCatalogEntry, 'sheet' | 'section' | 'category' | 'name'>) => `${e.sheet}|${e.section}|${e.category}|${e.name.replace(/\s+/g, '').toLowerCase()}`;

/** 切换生效前的条数核对：与表格对不上的写成一句一句 */
export function countMismatches(counts: PriceCountCheck[]): string[] {
  const out: string[] = [];
  for (const c of counts) {
    if (c.actual !== c.expected) out.push(`${c.name}：系统 ${c.actual} / 表格 ${c.expected}`);
    for (const p of c.parts) if (p.actual !== p.expected) out.push(`${c.name} · ${p.name}：系统 ${p.actual} / 表格 ${p.expected}`);
  }
  return out;
}

export type PriceChangeAction = 'create' | 'update' | 'deactivate' | 'reactivate';
export const PRICE_CHANGE_LABELS: Record<PriceChangeAction, string> = { create: '新增', update: '修改', deactivate: '停用', reactivate: '启用' };

/** 改价留痕的一条：经办人、时间、改前与改后（「旧价 → 新价」由 priceChangeLines 算） */
export interface PriceChange {
  id: number;
  setId: number;
  entryId: number;
  action: PriceChangeAction;
  entryName: string;
  before: PriceCatalogEntry | null;
  after: PriceCatalogEntry;
  priceChanged: boolean;
  reason: string;
  staffName: string;
  createdAt: string;
}

/** 改了什么：一行一个字段「标签：旧 → 新」；价格那一行在最前 */
export function priceChangeLines(before: PriceCatalogEntry | null, after: PriceCatalogEntry, yuan: (cents: number) => string): { label: string; from: string; to: string }[] {
  const money = (v: number | null) => (v === null ? '—' : yuan(v));
  const text = (e: PriceCatalogEntry) => ({
    价格: priceText(e, yuan),
    分档: e.variants.map((v) => `${v.label} ${v.priceCents === null ? '—' : yuan(v.priceCents)}`).join('；'),
    [e.sheet === 'entertainment' ? '加钟' : '超时']: e.extraPriceCents === null ? '—' : `${yuan(e.extraPriceCents)}/${minutesText(e.extraMinutes ?? 60)}`,
    封顶: money(e.capCents),
    名称: e.name,
    编号: e.code,
    [e.sheet === 'dish' ? '餐段' : '板块']: e.section,
    分类: e.category,
    单位: e.unit,
    时长: minutesText(e.durationMinutes),
    时段: windowText(e.windowStart, e.windowEnd),
    [e.sheet === 'entertainment' ? '台位' : '间数']: e.unitsCount === null ? '' : String(e.unitsCount),
    房号: e.roomNumbers.join(' '),
    适用房型: e.venues.map((v) => PRICE_VENUE_LABELS[v]).join(' / '),
    适用性别: e.gender ? PRICE_GENDER_LABELS[e.gender] : '',
    能否下单: e.orderable ? '可下单' : '不可下单',
    状态: e.active ? '在用' : '已停用',
    备注: e.note,
    核心人群: e.audience,
    操作内容: e.content,
    项目亮点: e.highlight,
  });
  const to = text(after);
  const from = before ? text(before) : null;
  return Object.entries(to)
    .filter(([k, v]) => (from ? from[k] !== v : v !== '' && v !== '—' && k !== '状态' && k !== '能否下单'))
    .map(([label, v]) => ({ label, from: from ? from[label] || '（空）' : '', to: v || '（空）' }));
}
