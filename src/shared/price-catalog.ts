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
  const a = new Map(active.map((e) => [priceEntryKey(e), e]));
  const d = new Map(draft.map((e) => [priceEntryKey(e), e]));
  const sig = (e: PriceCatalogEntry) => JSON.stringify([e.priceMode, e.priceCents, e.price2Cents, e.rateBp, e.extraPriceCents, e.capCents, e.active, e.orderable]);
  const out: PriceDiff[] = [];
  for (const [key, e] of d) {
    const old = a.get(key);
    if (!old) out.push({ key, change: 'added', draft: e, active: null });
    else if (sig(old) !== sig(e)) out.push({ key, change: 'changed', draft: e, active: old });
  }
  for (const [key, e] of a) if (!d.has(key)) out.push({ key, change: 'removed', draft: null, active: e });
  return out;
}
