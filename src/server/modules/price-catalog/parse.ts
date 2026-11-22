// 价目表导入：把《汤崎宝安全品类价目表 1119》六张表读成价目表条目（docs/PRICE_CATALOG.md 第 3 节，PC1 起）。
// 只做读与逐行校验，不碰数据库；报错写明工作表、行号、字段与原因（价格为空、时长格式不支持、名称重复、板块不存在……）。
// 表里的写法照门店的原表认：「399/2H起开」「超时199/H」「999封顶过夜」「加钟/19.9」「7：30--10：00」「80min / 80分钟 / 80'」……
// 合并单元格（门票、餐票、菜品分类、按摩板块）先把左上角的值填满整个合并区域再逐行读。

import {
  DISH_SECTIONS,
  priceEntryProblems,
  priceNameKey,
  MASSAGE_SECTIONS,
  PRICE_ROOM_NUMBERS_MAX,
  PRICE_SHEET_NAMES,
  PRICE_VARIANTS_MAX,
  STORED_VALUE_SHEET_NAME,
  type PriceCatalogEntry,
  type PriceGender,
  type PriceImportIssue,
  type PriceSheet,
  type PriceVariant,
  type PriceVenue,
} from '@shared/price-catalog';
import type { XlsxSheet, XlsxWorkbook } from '../../lib/xlsx-read';

type Grid = Map<number, Map<number, string>>;

/** 文件本身就不对（合并区域大得离谱之类）：整份不读，预览、导入都返回「文件不对」 */
export class PriceFileError extends Error {}

/** 一个合并区域、一张表展开合并区域最多填多少格（原表最大的合并区域几十格） */
const MERGE_AREA_MAX = 2_000;
const MERGE_CELLS_MAX = 50_000;
/** 一个房型最多合并多少行（轰趴房按面积一行一档，原表 4 行） */
const GROUP_ROWS_MAX = 20;
/** 最小值（不把整个数组展开给 Math.min）；空的为 null */
const minOf = (values: number[]): number | null => values.reduce<number | null>((m, v) => (m === null || v < m ? v : m), null);
/** 一张表最多多少行有内容（原表零点菜品一百四十来行；一行至多一项） */
const SHEET_ROWS_MAX = 2_000;
/** 整份最多生成多少项（原表 224 项）、一项最多多少档（PRICE_VARIANTS_MAX，与页面编辑同一个上限）：超过的不像价目表，不先建一大堆条目再一项项校验（Codex 安全审查） */
const ENTRIES_MAX = 3_000;

/** 工作表 → 行号 → 列号 → 文字（合并区域填满；合并区域过大的整份拒绝，不在请求线程里填几十亿格） */
function gridOf(sheet: XlsxSheet): Grid {
  const g: Grid = new Map();
  const put = (r: number, c: number, v: string) => {
    if (!g.has(r)) g.set(r, new Map());
    g.get(r)!.set(c, v);
  };
  for (const [r, line] of sheet.rows) for (const [c, cell] of line) if (cell.value !== null && cell.value.trim() !== '') put(r, c, cell.value);
  let filled = 0;
  for (const m of sheet.merges) {
    const area = (m.r2 - m.r1 + 1) * (m.c2 - m.c1 + 1);
    filled += area;
    if (area > MERGE_AREA_MAX || filled > MERGE_CELLS_MAX) throw new PriceFileError(`「${sheet.name}」里的合并单元格太大（${area} 格），不像价目表；请检查表格后再导入`);
    const v = g.get(m.r1)?.get(m.c1);
    if (v === undefined) continue;
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (!g.get(r)?.get(c)) put(r, c, v);
  }
  return g;
}
const at = (g: Grid, r: number, c: number) => (g.get(r)?.get(c) ?? '').trim();
const rowsOf = (g: Grid) => [...g.keys()].sort((a, b) => a - b);
/** 全角数字、冒号、空白都按半角认 */
const half = (s: string) =>
  s
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/ /g, ' ');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 元 → 分（最多两位小数；0.1 这种比例不走这里） */
export function yuanToCents(text: string): number | null {
  const t = half(text).replace(/[,，元¥￥\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const v = Math.round(Number(t) * 100);
  return v > 0 ? v : null;
}

/** 时长：「80min」「80分钟」「60'」「90’」「2H」「2h」「6小时」「12H」→ 分钟；看不懂的、不在 1–2880 分钟（两天）里的为 null */
export function minutesOf(text: string): number | null {
  const t = half(text).replace(/\s+/g, '').toLowerCase();
  const inRange = (v: number) => (v >= 1 && v <= 2880 ? v : null);
  let m = /^(\d+(?:\.\d+)?)(min|mins|分钟|分|'|’|′)?$/.exec(t);
  if (m) return inRange(Math.round(Number(m[1])));
  m = /^(\d+(?:\.\d+)?)(h|小时|个小时)$/.exec(t);
  if (m) return inRange(Math.round(Number(m[1]) * 60));
  return null;
}

/** 「7：30--10：00」「21点-次日11点」「23：30--2：00」→ [开始, 结束]（分钟） */
export function windowOf(text: string): [number, number] | null {
  const t = half(text).replace(/\s+/g, '').replace(/次日/g, '');
  const m = /^(\d{1,2})(?::(\d{2})|点(\d{2})?分?)?[-—–~～至到]+(\d{1,2})(?::(\d{2})|点(\d{2})?分?)?$/.exec(t);
  if (!m) return null;
  // 时、分各自要合法：「7:99」不换算成 8:39
  const ha = Number(m[1]);
  const ma = Number(m[2] ?? m[3] ?? 0);
  const hb = Number(m[4]);
  const mb = Number(m[5] ?? m[6] ?? 0);
  if (ha > 23 || hb > 23 || ma > 59 || mb > 59) return null;
  return [ha * 60 + ma, hb * 60 + mb];
}

/** 房号清单：「S301-S339」「F301-307」「H203-209」「R01-R08」「Q301 Q302」「S328—S336」，去重、保持先后；认到 PRICE_ROOM_NUMBERS_MAX + 1 个就停 */
export function roomNumbersOf(text: string): string[] {
  const out = new Set<string>();
  const add = (n: string) => {
    out.add(n);
  };
  const t = half(text);
  const re = /([A-Za-z]{1,2})(\d{2,4})(?:\s*[-—–~～]\s*([A-Za-z]{1,2})?(\d{2,4}))?/g;
  for (const m of t.matchAll(re)) {
    if (out.size > PRICE_ROOM_NUMBERS_MAX) break;
    const prefix = m[1]!.toUpperCase();
    const from = m[2]!;
    if (!m[4]) {
      add(prefix + from);
      continue;
    }
    const to = m[4];
    const a = Number(from);
    const b = Number(to.length < from.length ? from.slice(0, from.length - to.length) + to : to);
    if (b < a) {
      add(prefix + from);
      continue;
    }
    // 区间照实展开，最多展开到超过上限一个（够调用方报「房号太多」），不把长区间悄悄当成一个房号
    for (let n = a; n <= b && out.size <= PRICE_ROOM_NUMBERS_MAX; n++) add(prefix + String(n).padStart(from.length, '0'));
  }
  return [...out].slice(0, PRICE_ROOM_NUMBERS_MAX + 1);
}

const blank = (sheet: PriceSheet, kind: PriceCatalogEntry['kind'], name: string, row: number, sort: number): PriceCatalogEntry => ({
  sheet,
  kind,
  section: '',
  category: '',
  code: '',
  name: oneLine(name).slice(0, 48),
  priceMode: 'none',
  priceCents: null,
  price2Cents: null,
  rateBp: null,
  unit: '',
  durationMinutes: null,
  extraPriceCents: null,
  extraMinutes: null,
  capCents: null,
  unitsCount: null,
  roomNumbers: [],
  windowStart: null,
  windowEnd: null,
  includesMeal: null,
  venues: [],
  gender: null,
  audience: '',
  content: '',
  highlight: '',
  note: '',
  variants: [],
  orderable: true,
  active: true,
  sourceRow: row,
  sortOrder: sort,
});
const single = (e: PriceCatalogEntry, cents: number | null): PriceCatalogEntry =>
  cents === null ? { ...e, priceMode: 'none', priceCents: null, price2Cents: null } : { ...e, priceMode: 'single', priceCents: cents, price2Cents: null };

interface Ctx {
  issues: PriceImportIssue[];
  error(sheet: PriceSheet, row: number | null, field: string, message: string): void;
  warn(sheet: PriceSheet, row: number | null, field: string, message: string): void;
}

/**
 * 表头那一行：前 6 行里第一行有 keys 这几个名字的。required 是这张表读到的每一列：缺了或写错字（「资深价格」）
 * 整列就成了空的（双价悄悄变单价、时段悄悄没了），所以报错写明少了哪一列，整份不导
 */
function headerRow(g: Grid, ctx: Ctx, S: PriceSheet, keys: string[], required: string[]): { row: number; cols: Map<string, number> } | null {
  for (const r of rowsOf(g).slice(0, 6)) {
    const line = g.get(r)!;
    const cols = new Map<string, number>();
    for (const [c, v] of line) cols.set(oneLine(v), c);
    if (!keys.every((n) => cols.has(n))) continue;
    const missing = required.filter((n) => !cols.has(n));
    if (missing.length) {
      ctx.error(S, r, '表头', `表头少了「${missing.join('」「')}」（表头写：${required.join('、')}；写错字也算少了）`);
      return null;
    }
    return { row: r, cols };
  }
  ctx.error(S, null, '表头', `没找到表头（要有「${required.join('」「')}」）`);
  return null;
}

// ───────────────────────── 门店价格 ─────────────────────────

function storeSheet(g: Grid, ctx: Ctx): PriceCatalogEntry[] {
  const S: PriceSheet = 'store';
  const head = headerRow(g, ctx, S, ['类型', '项目', '价格'], ['类型', '项目', '价格', '备注', '时间']);
  if (!head) return [];
  const col = (n: string) => head.cols.get(n) ?? -1;
  const out: PriceCatalogEntry[] = [];
  for (const r of rowsOf(g).filter((r) => r > head.row)) {
    const type = oneLine(at(g, r, col('类型')));
    const item = oneLine(at(g, r, col('项目')));
    const priceText = at(g, r, col('价格'));
    const note = oneLine(at(g, r, col('备注')));
    const time = at(g, r, col('时间'));
    if (!type && !item && !priceText) continue;
    const sort = out.length + 1;
    if (type === '服务费') {
      const v = Number(half(priceText).replace('%', ''));
      const bp = priceText.includes('%') ? Math.round(v * 100) : Math.round(v * 10000);
      if (!Number.isFinite(v) || bp < 1 || bp > 10000) ctx.error(S, r, '价格', `服务费比例「${priceText}」看不懂（写 0.1 或 10%）`);
      else out.push({ ...blank(S, 'service_fee', '服务费', r, sort), section: type, priceMode: 'rate', rateBp: bp, note: oneLine([note, time].filter(Boolean).join('；')) });
      continue;
    }
    const cents = yuanToCents(priceText);
    if (cents === null) {
      ctx.error(S, r, '价格', priceText ? `价格「${oneLine(priceText)}」不对（写元，最多 2 位小数）` : '价格为空');
      continue;
    }
    if (type === '门票') {
      const minutes = minutesOf(item);
      if (minutes === null) ctx.error(S, r, '项目', `门票时长「${item}」看不懂（写 12H、24H）`);
      const meal = /含/.test(note) && !/不含/.test(note);
      out.push({
        ...single(blank(S, 'ticket', `门票 ${item} ${meal ? '含餐' : '不含餐'}`, r, sort), cents),
        section: type,
        durationMinutes: minutes,
        includesMeal: meal,
        unit: '张',
        note: oneLine([note, time].filter(Boolean).join('；')),
      });
    } else if (type === '夜间票') {
      const w = windowOf(item);
      if (!w) ctx.error(S, r, '项目', `夜间票时段「${item}」看不懂（写 21点-次日11点）`);
      out.push({
        ...single(blank(S, 'night_ticket', '夜间票', r, sort), cents),
        section: type,
        windowStart: w?.[0] ?? null,
        windowEnd: w?.[1] ?? null,
        unit: '张',
        note: oneLine([note && `含${note}`, time].filter(Boolean).join('；')),
      });
    } else if (type === '餐票') {
      const w = windowOf(time);
      if (!w) ctx.error(S, r, '时间', `供应时段「${oneLine(time)}」看不懂（写 7:30--10:00）`);
      out.push({ ...single(blank(S, 'meal_ticket', `${item}餐票`, r, sort), cents), section: type, windowStart: w?.[0] ?? null, windowEnd: w?.[1] ?? null, unit: '张', note });
    } else ctx.error(S, r, '类型', `类型「${type}」不认识（门票、夜间票、餐票、服务费）`);
  }
  return out;
}

// ───────────────────────── 娱乐价格 ─────────────────────────

/** 「39/2h」→ 3900 分含 120 分钟；「99」→ 9900 分 */
function perTime(text: string): { cents: number; minutes: number | null } | null {
  const t = half(text).replace(/\s+/g, '');
  const m = /^(\d+(?:\.\d{1,2})?)(?:元)?(?:\/(\d+(?:\.\d+)?(?:h|H|小时|min|分钟)))?(?:起开)?$/.exec(t);
  if (!m) return null;
  const cents = yuanToCents(m[1]!);
  if (cents === null) return null;
  // 写了时长却不合法（39/0min、39/3000min）：看不懂，不能当成没写时长（那会变成按次的畅玩卷）
  const minutes = m[2] ? minutesOf(m[2]) : null;
  if (m[2] && minutes === null) return null;
  return { cents, minutes };
}

function entertainmentSheet(g: Grid, ctx: Ctx): PriceCatalogEntry[] {
  const S: PriceSheet = 'entertainment';
  const head = headerRow(g, ctx, S, ['类型', '价格'], ['类型', '数量', '价格', '备注']);
  if (!head) return [];
  const col = (n: string) => head.cols.get(n) ?? -1;
  const out: PriceCatalogEntry[] = [];
  for (const r of rowsOf(g).filter((r) => r > head.row)) {
    const name = oneLine(at(g, r, col('类型')));
    const count = at(g, r, col('数量'));
    const priceText = at(g, r, col('价格'));
    const note = oneLine(at(g, r, col('备注')));
    if (!name && !priceText) continue;
    const sort = out.length + 1;
    const p = perTime(priceText);
    if (!priceText) ctx.error(S, r, '价格', '价格为空');
    else if (!p) ctx.error(S, r, '价格', `价格「${oneLine(priceText)}」看不懂（写 39/2h 或 99）`);
    const units = count ? Number(half(count).replace(/[台张间个\s]/g, '')) : null;
    if (count && (!Number.isInteger(units) || units! < 0)) ctx.error(S, r, '数量', `数量「${count}」不对（写台位数，整数）`);
    // 加钟价整段认：「加钟/19.9」；19.999 这种多出来的位数报错，不截成 19.99
    // 「加钟/1,999」这种带千位分隔符的：认不出，报错（不截成 1 元）
    const extra = /加钟\s*[/／:：]?\s*(\d+(?:\.\d+)?)(?![\d.])(?!\s*[,，]\s*\d)/.exec(half(note));
    const extraCents = extra ? yuanToCents(extra[1]!) : null;
    if (/加钟/.test(note) && extraCents === null) ctx.error(S, r, '备注', `加钟价「${note}」看不懂（写 加钟/19.9，最多 2 位小数）`);
    if (!p) continue;
    const isPass = p.minutes === null && !extra;
    const e = single(blank(S, isPass ? 'play_pass' : 'entertainment', name, r, sort), p.cents);
    out.push({
      ...e,
      durationMinutes: p.minutes,
      extraPriceCents: extraCents,
      extraMinutes: extraCents !== null ? 60 : null,
      unitsCount: count && Number.isInteger(units) ? units : null,
      unit: isPass ? '次' : '',
      note: extra ? oneLine(note.replace(extra[0], '')) : note,
    });
  }
  return out;
}

// ───────────────────────── 房间价格 ─────────────────────────

/** 金额最多两位小数：「599.999」这种整段报错，不截出其中一段当价格（金额匹配都带了前后边界，截不出子串，这里写明是哪一行） */
function checkDecimals(ctx: Ctx, S: PriceSheet, row: number, field: string, text: string) {
  const bad = /\d+\.\d{3,}/.exec(half(text));
  if (bad) ctx.error(S, row, field, `金额「${bad[0]}」不对：按元写，最多两位小数`);
  // 金额前的负号（「-599/晚」「-999封顶」）：报错，不丢掉负号当正价收（房号区间这些写在备注，不在收费参考里）
  const negative = /(^|[^\dA-Za-z])[-－−]\s*\d+(?:\.\d+)?/.exec(half(text));
  if (negative) ctx.error(S, row, field, `金额「${negative[0].replace(/^[^-－−]/, '').trim()}」不对：价格不能是负数`);
  // 千位分隔符（「3,000」「1,999封顶」）：报错，不截成逗号前后的一段当价格（逗号也可能是两个价之间的分隔，不猜）
  const grouped = /\d\s*[,，]\s*\d/.exec(half(text));
  if (grouped) ctx.error(S, row, field, `金额「${grouped[0]}」看不懂：数字里不要写逗号（千位分隔符），一个价写成 3000 这样`);
}

/** 「超时199/H」→ 每 60 分钟 19900 分 */
function overtimeOf(text: string): { cents: number; minutes: number } | null {
  const m = /超时\s*(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*(?:元)?\s*[/／]\s*(\d*)\s*(h|H|小时)/.exec(half(text));
  if (!m) return null;
  const cents = yuanToCents(m[1]!);
  return cents === null ? null : { cents, minutes: (m[2] ? Number(m[2]) : 1) * 60 };
}
const capOf = (text: string) => {
  const m = /(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*(?:元)?\s*封顶/.exec(half(text));
  return m ? yuanToCents(m[1]!) : null;
};
/** 「6小时：999」「12小时 ：1599」「包天：5000」「699/8H」「399/3小时」 → 档 */
function hourTiers(text: string): PriceVariant[] {
  const out: PriceVariant[] = [];
  const t = half(text);
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(小时|H|h)\s*:\s*(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])/g)) {
    const minutes = Math.round(Number(m[1]) * 60);
    out.push({ label: `${m[1]}小时`, minutes, priceCents: yuanToCents(m[3]!), unit: '' });
  }
  for (const m of t.matchAll(/包天\s*:\s*(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])/g)) out.push({ label: '包天', minutes: null, priceCents: yuanToCents(m[1]!), unit: '天' });
  for (const m of t.matchAll(/(?<![超\d.])(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*[/／]\s*(\d+(?:\.\d+)?)\s*(H|h|小时)(?!起开)/g)) {
    const minutes = Math.round(Number(m[2]) * 60);
    out.push({ label: `${m[2]}小时`, minutes, priceCents: yuanToCents(m[1]!), unit: '' });
  }
  return out;
}

function roomSheet(g: Grid, ctx: Ctx): PriceCatalogEntry[] {
  const S: PriceSheet = 'room';
  const roomsAt = (row: number, text: string) => {
    const list = roomNumbersOf(text);
    if (list.length > PRICE_ROOM_NUMBERS_MAX) ctx.error(S, row, '备注', `房号太多（超过 ${PRICE_ROOM_NUMBERS_MAX} 个），请核对房号清单`);
    return list.slice(0, PRICE_ROOM_NUMBERS_MAX);
  };
  const head = headerRow(g, ctx, S, ['房型', '总数'], ['房型', '总数', '收费参考', '备注']);
  if (!head) return [];
  const cType = head.cols.get('房型')!;
  const cCount = head.cols.get('总数')!;
  const cPrice = head.cols.get('收费参考') ?? cCount + 1;
  const cRule = cPrice + 1;
  const cNote = head.cols.get('备注') ?? cPrice + 2;
  const cExtra = cNote + 1;
  const rows = rowsOf(g).filter((r) => r > head.row);
  const out: PriceCatalogEntry[] = [];
  // 合并的房型（轰趴房占 4 行）按房型合成一项，每一行是一档
  const groups: { type: string; rows: number[] }[] = [];
  for (const r of rows) {
    const type = oneLine(at(g, r, cType));
    if (!type && !at(g, r, cPrice)) continue;
    const last = groups[groups.length - 1];
    if (last && last.type === type) last.rows.push(r);
    else groups.push({ type, rows: [r] });
  }
  for (const grp of groups) {
    // 一个房型合并的行（轰趴房按面积一行一档）：原表 4 行；几百上千行的不像价目表，整份拒绝（不先生成一大堆档）
    if (grp.rows.length > GROUP_ROWS_MAX) throw new PriceFileError(`「${grp.type}」连着 ${grp.rows.length} 行，超过 ${GROUP_ROWS_MAX} 行，不像价目表；请检查表格后再导入`);
    const r = grp.rows[0]!;
    const sort = out.length + 1;
    if (!grp.type) {
      ctx.error(S, r, '房型', '房型为空');
      continue;
    }
    const countText = at(g, r, cCount);
    const units = countText ? Number(half(countText).replace(/[间个\s]/g, '')) : null;
    if (countText && !Number.isInteger(units)) ctx.error(S, r, '总数', `总数「${countText}」不对（写 35间 这样）`);
    const price = at(g, r, cPrice);
    const rule = at(g, r, cRule);
    for (const x of grp.rows) {
      checkDecimals(ctx, S, x, '收费参考', `${at(g, x, cPrice)}\n${at(g, x, cRule)}`);
    }
    const note = at(g, r, cNote);
    const extraNote = oneLine(grp.rows.map((x) => at(g, x, cExtra)).find(Boolean) ?? '');
    const base = { ...blank(S, 'room_type', grp.type, r, sort), unitsCount: units !== null && Number.isInteger(units) ? units : null };

    if (/轰趴/.test(grp.type)) {
      // 一行一档：面积、房号、几人位、6 / 12 小时与包天的价
      const variants: PriceVariant[] = [];
      for (const x of grp.rows) {
        const desc = half(at(g, x, cNote));
        const area = /(\d+)\s*平/.exec(desc)?.[1];
        const seats = /(\d+)\s*人位/.exec(desc)?.[1];
        const tiers = hourTiers(`${at(g, x, cPrice)}\n${at(g, x, cRule)}`);
        if (!tiers.length) ctx.error(S, x, '收费参考', `「${oneLine(at(g, x, cPrice))}」看不懂（写 6小时：999）`);
        // 每一行都要认得出一档：「12小时：abc」这样的不能只留下认得的那几档、把它悄悄丢掉
        else {
          for (const line of `${at(g, x, cPrice)}\n${at(g, x, cRule)}`.split('\n').map(oneLine).filter(Boolean)) {
            if (!hourTiers(line).length) ctx.error(S, x, '收费参考', `「${line}」看不懂（写 6小时：999、包天：5000）`);
          }
        }
        const t6 = tiers.find((t) => t.minutes === 360)?.priceCents;
        const t12 = tiers.find((t) => t.minutes === 720)?.priceCents;
        if (t6 && t12 && t12 < t6) ctx.warn(S, x, '收费参考', `${area ?? ''}平：12 小时价（${t12 / 100}）比 6 小时价（${t6 / 100}）还低，请门店核对表格`);
        for (const t of tiers) {
          variants.push({ ...t, label: `${area ? `${area}平 ` : ''}${t.label}`, roomNumbers: roomsAt(x, desc), ...(seats ? { seats: Number(seats) } : {}) });
        }
      }
      const prices = variants.map((v) => v.priceCents).filter((v): v is number => v !== null);
      out.push({
        ...single({ ...base, kind: 'party_room' }, minOf(prices)),
        durationMinutes: 360,
        roomNumbers: [...new Set(variants.flatMap((v) => v.roomNumbers ?? []))],
        variants,
        note: extraNote,
      });
      checkRooms(ctx, S, r, grp.type, base.unitsCount, [...new Set(variants.flatMap((v) => v.roomNumbers ?? []))]);
      continue;
    }

    if (/餐饮包房/.test(grp.type)) {
      const t = half(price);
      const variants: PriceVariant[] = [...t.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*元\s*[/／]\s*位/g)].map((m) => ({
        label: '位价',
        priceCents: yuanToCents(m[1]!),
        minutes: null,
        unit: '位',
      }));
      const min = /低[销消]\s*:?\s*(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])/.exec(t);
      if (min) variants.push({ label: '低消', priceCents: yuanToCents(min[1]!), minutes: null, unit: '起', note: oneLine(t.slice(min.index).split('\n')[0] ?? '') });
      // 写了「低消」，却认不出合法金额（「低消：另议」）：报错，不当成没有最低消费
      if (/低[销消]/.test(t) && (!min || yuanToCents(min[1]!) === null)) ctx.error(S, r, '收费参考', '「低消」的金额看不懂或不对（写 低消：6888元，金额大于 0、最多两位小数）');
      const over = /超出按照\s*(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*元?\s*[/／]\s*小时/.exec(t);
      // 写了「超出按照」，却认不出合法金额（负数、文字、0 元）：报错，不当成没有超时收费
      if (/超出按照/.test(t) && (!over || yuanToCents(over[1]!) === null)) ctx.error(S, r, '收费参考', '「超出按照 … 元/小时」的金额看不懂或不对（写 超出按照588元/小时，金额大于 0、最多两位小数）');
      // 位价逐行核对：写了「…/位」却认不出合法金额的一行报错（不跳过它只留下认得的档）
      for (const line of t.split('\n').filter((x) => /[/／]\s*位/.test(x))) {
        const m = /(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*元\s*[/／]\s*位/.exec(line);
        if (!m || yuanToCents(m[1]!) === null) ctx.error(S, r, '收费参考', `位价「${oneLine(line)}」看不懂或金额不对（写 688元/位，金额大于 0、最多两位小数）`);
      }
      if (!variants.length) ctx.error(S, r, '收费参考', '没认出位价（写 688元/位）');
      const perHead = variants.filter((v) => v.unit === '位').map((v) => v.priceCents!);
      out.push({
        ...single({ ...base, kind: 'dining_room' }, minOf(perHead)),
        unit: '位',
        extraPriceCents: over ? yuanToCents(over[1]!) : null,
        extraMinutes: over ? 60 : null,
        roomNumbers: roomsAt(r, note),
        variants,
        // 开瓶费、超时费等原样留作备注
        note: oneLine([rule, /次日[^，。,\n]*退房[^。\n]*/.exec(t)?.[0] ?? '', extraNote].filter(Boolean).join('；')).slice(0, 400),
      });
      continue;
    }

    if (/客房/.test(grp.type)) {
      // 「小房间 599/晚  大房间 699/晚」与「399/3小时  499/3小时」：按先后配对成大小房的过夜价与钟点价。
      // 逐行认：写了却认不出的一行报错（不跳过它再按先后配对——那会把大房间的钟点价配给小房间）；两边行数不一样也报错
      const lines = (t: string) =>
        half(t)
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean);
      const night: { label: string; cents: number | null }[] = [];
      for (const line of lines(price)) {
        const m = /^([^\d\-－]*?)\s*(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*[/／]\s*晚$/.exec(line);
        if (m) night.push({ label: oneLine(m[1]!) || '过夜', cents: yuanToCents(m[2]!) });
        else ctx.error(S, r, '收费参考', `客房过夜价「${oneLine(line)}」看不懂（一行写一个，例如 小房间 599/晚）`);
      }
      const hourly: { cents: number | null; minutes: number }[] = [];
      for (const line of lines(rule)) {
        const m = /^(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])\s*[/／]\s*(\d+(?:\.\d+)?)\s*(小时|H|h)$/.exec(line);
        if (m) hourly.push({ cents: yuanToCents(m[1]!), minutes: Math.round(Number(m[2]) * 60) });
        else ctx.error(S, r, '收费参考', `客房钟点价「${oneLine(line)}」看不懂（一行写一个，例如 399/3小时）`);
      }
      if (!lines(price).length) ctx.error(S, r, '收费参考', '价格为空（写 小房间 599/晚）');
      if (hourly.length && night.length && hourly.length !== night.length) {
        ctx.error(S, r, '收费参考', `过夜价 ${night.length} 个、钟点价 ${hourly.length} 个，对不上是哪种房的；一种房一行，两列行数一样`);
      }
      const variants: PriceVariant[] = [
        ...night.map((n) => ({ label: `${n.label} 过夜`, priceCents: n.cents, minutes: null, unit: '晚' })),
        ...hourly.map((h, i) => ({ label: `${night[i]?.label ?? ''} ${h.minutes / 60}小时`.trim(), priceCents: h.cents, minutes: h.minutes, unit: '' })),
      ];
      const nights = night.map((n) => n.cents).filter((v): v is number => v !== null);
      const rooms = roomsAt(r, note);
      out.push({ ...single(base, minOf(nights)), unit: '晚', roomNumbers: rooms, variants });
      checkRooms(ctx, S, r, grp.type, base.unitsCount, rooms);
      continue;
    }

    // 按房间计时的房型：「399/2H起开」「超时199/H」「999封顶过夜」（棋牌房另有「699/8H」）
    const start = perTime(price);
    if (!price) ctx.error(S, r, '收费参考', '价格为空');
    else if (!start || start.minutes === null) ctx.error(S, r, '收费参考', `「${oneLine(price)}」看不懂（写 399/2H起开）`);
    const over = overtimeOf(rule);
    const cap = capOf(rule);
    // 写了超时 / 封顶，金额却不合法（「0封顶」「超时0/H」）：报错，不当成没有超时价、没有封顶
    if (/超时/.test(rule) && !over) ctx.error(S, r, '收费参考', `超时价「${oneLine(rule)}」看不懂或金额不对（写 超时199/H，金额大于 0、最多两位小数）`);
    else if (rule && !over) ctx.warn(S, r, '备注', `超时价「${oneLine(rule)}」没认出来`);
    if (/封顶/.test(rule) && cap === null) ctx.error(S, r, '收费参考', `封顶价「${oneLine(rule)}」看不懂或金额不对（写 999封顶，金额大于 0、最多两位小数）`);
    const rooms = roomsAt(r, note.split('\n')[0] ?? note);
    out.push({
      ...single(base, start?.cents ?? null),
      durationMinutes: start?.minutes ?? null,
      extraPriceCents: over?.cents ?? null,
      extraMinutes: over?.minutes ?? null,
      capCents: cap,
      roomNumbers: rooms,
      variants: hourTiers(rule.replace(/超时[^\n]*/g, '')),
      note: oneLine(note.split('\n').slice(1).join('；')),
    });
    checkRooms(ctx, S, r, grp.type, base.unitsCount, rooms);
  }
  return out;
}

function checkRooms(ctx: Ctx, S: PriceSheet, r: number, type: string, units: number | null, rooms: string[]) {
  if (units !== null && rooms.length && rooms.length !== units) {
    ctx.warn(S, r, '备注', `${type}：总数写 ${units} 间，房号清单算出来是 ${rooms.length} 个（${rooms[0]}–${rooms[rooms.length - 1]}），请门店核对`);
  }
}

// ───────────────────────── 零点菜品价格 ─────────────────────────

const DISH_HEADS = ['序号', '菜品分类', '菜品名称', '售价', '单位'];
const DISH_REQUIRED = ['菜品分类', '菜品名称', '售价', '单位'];

function dishSheet(g: Grid, ctx: Ctx): PriceCatalogEntry[] {
  const S: PriceSheet = 'dish';
  const out: PriceCatalogEntry[] = [];
  let section = '';
  let cols: Map<string, number> | null = null;
  // 这一段已经报过「表头不对」
  let headless = false;
  let category = '';
  const seen = new Map<string, number>();
  for (const r of rowsOf(g)) {
    const line = g.get(r)!;
    const texts = [...line.values()].map(oneLine);
    // 分段标题：「2楼餐厅零点菜品」「早餐自助零点菜品」……（合并成一整行）
    const titleText = texts.length && new Set(texts).size === 1 && /菜品/.test(texts[0]!) ? texts[0]! : null;
    if (titleText) {
      section = /早餐/.test(titleText) ? '早餐' : /午餐/.test(titleText) ? '午餐' : /晚餐/.test(titleText) ? '晚餐' : /2\s*楼|二楼/.test(titleText) ? '2楼零点' : titleText.slice(0, 20);
      if (!(DISH_SECTIONS as readonly string[]).includes(section)) ctx.error(S, r, '餐段', `餐段「${titleText}」不认识（2楼零点、早餐、午餐、晚餐）`);
      cols = null;
      headless = false;
      category = '';
      continue;
    }
    // 表头行：含「序号 / 菜品分类 / 菜品名称 / 售价 / 单位」里的两个以上；必要的列缺了（写错字）整份报错，不悄悄跳过
    if (texts.filter((t) => DISH_HEADS.includes(t)).length >= 2) {
      const found = new Map([...line].map(([c, v]) => [oneLine(v), c]));
      const missing = DISH_REQUIRED.filter((h) => !found.has(h));
      if (missing.length) ctx.error(S, r, '表头', `${section || '这一段'}的表头少了「${missing.join('」「')}」（表头写：${DISH_HEADS.join('、')}）`);
      cols = missing.length ? null : found;
      headless = !!missing.length;
      continue;
    }
    if (!cols) {
      // 有餐段、有内容却没有认得的表头：报一次错
      if (section && !headless && texts.some(Boolean)) {
        ctx.error(S, r, '表头', `${section}下面没有认出表头（表头写：${DISH_HEADS.join('、')}）`);
        headless = true;
      }
      continue;
    }
    const name = oneLine(at(g, r, cols.get('菜品名称') ?? -1));
    if (!name) continue;
    const cat = oneLine(at(g, r, cols.get('菜品分类') ?? -1));
    if (cat) category = cat;
    const priceText = at(g, r, cols.get('售价') ?? -1);
    const unit = oneLine(at(g, r, cols.get('单位') ?? -1));
    const cents = priceText ? yuanToCents(priceText) : null;
    if (priceText && cents === null) ctx.error(S, r, '售价', `售价「${priceText}」不对（写元，最多 2 位小数）`);
    if (!section) ctx.error(S, r, '餐段', '这一行上面没有餐段标题（2楼餐厅零点菜品、早餐自助零点菜品……）');
    // 与页面编辑同一个查重键（不分大小写、不管空格）
    const key = priceNameKey({ sheet: S, section, category, name });
    if (seen.has(key)) ctx.error(S, r, '菜品名称', `名称重复：「${name}」在${section}「${category}」里第 ${seen.get(key)} 行已经有了`);
    seen.set(key, r);
    if (!priceText) ctx.warn(S, r, '售价', `「${name}」暂无售价：录为「待定价」，不能下单，补价后启用`);
    out.push({
      ...single(blank(S, 'dish', name, r, out.length + 1), cents),
      section,
      category,
      code: oneLine(at(g, r, cols.get('序号') ?? -1)).slice(0, 12),
      unit: unit.slice(0, 8),
      orderable: cents !== null,
    });
  }
  return out;
}

// ───────────────────────── 按摩及助浴价格 ─────────────────────────

const venuesOf = (text: string): PriceVenue[] => {
  const v: PriceVenue[] = [];
  if (/房间/.test(text)) v.push('room');
  if (/大堂|大厅/.test(text)) v.push('lobby');
  if (/浴区/.test(text)) v.push('bath');
  return v;
};
const genderOf = (text: string): PriceGender | null => {
  const t = text.replace(/\s+/g, '');
  if (/^(男\/女|女\/男|男女|不限)$/.test(t)) return 'any';
  if (t === '女') return 'female';
  if (t === '男') return 'male';
  return null;
};

function massageSheet(g: Grid, ctx: Ctx): PriceCatalogEntry[] {
  const S: PriceSheet = 'massage';
  const head = headerRow(g, ctx, S, ['板块分类', '项目名称'], ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点']);
  if (!head) return [];
  const col = (n: string) => head.cols.get(n) ?? -1;
  const out: PriceCatalogEntry[] = [];
  const seen = new Map<string, number>();
  let section = '';
  for (const r of rowsOf(g).filter((r) => r > head.row)) {
    const name = oneLine(at(g, r, col('项目名称')));
    const sec = oneLine(at(g, r, col('板块分类')));
    if (sec) section = sec;
    if (!name) continue;
    const code = oneLine(at(g, r, col('编号')));
    if (!(MASSAGE_SECTIONS as readonly string[]).includes(section)) ctx.error(S, r, '板块分类', `板块「${section || '（空）'}」不存在（${MASSAGE_SECTIONS.join('、')}）`);
    const durText = at(g, r, col('时长'));
    const minutes = durText ? minutesOf(durText) : null;
    if (durText && minutes === null) ctx.error(S, r, '时长', `时长格式不支持：「${oneLine(durText)}」（写 60min、60分钟、60'，在 1 到 2880 分钟之间）`);
    const p1Text = at(g, r, col('专业价'));
    const p2Text = at(g, r, col('资深价'));
    const p1 = p1Text ? yuanToCents(p1Text) : null;
    if (!p1Text) ctx.error(S, r, '专业价', '价格为空');
    else if (p1 === null) ctx.error(S, r, '专业价', `专业价「${p1Text}」不对（写元）`);
    // 资深价一列：数字是资深价；助浴等写的是适用性别（女、男/女），写进「适用性别」、不参与计价；「—」是没有资深价
    let p2: number | null = null;
    let gender: PriceGender | null = null;
    if (p2Text && !/^[—\-–－/]+$/.test(p2Text.trim())) {
      const g2 = genderOf(p2Text);
      if (g2) gender = g2;
      else {
        p2 = yuanToCents(p2Text);
        if (p2 === null) ctx.error(S, r, '资深价', `资深价「${p2Text}」不对（写元；助浴写适用性别「女」「男/女」）`);
      }
    }
    if (!gender) gender = /女宾/.test(name) ? 'female' : /男宾/.test(name) ? 'male' : null;
    const key = priceNameKey({ sheet: S, section, category: '', name });
    if (seen.has(key)) ctx.error(S, r, '项目名称', `名称重复：「${name}」在「${section}」第 ${seen.get(key)} 行已经有了`);
    seen.set(key, r);
    const base = blank(S, 'massage', name, r, out.length + 1);
    out.push({
      ...base,
      ...(p1 !== null && p2 !== null ? { priceMode: 'dual' as const, priceCents: p1, price2Cents: p2 } : p1 !== null ? { priceMode: 'single' as const, priceCents: p1, price2Cents: null } : {}),
      section,
      code: code.slice(0, 12),
      durationMinutes: minutes,
      venues: venuesOf(at(g, r, col('类型'))),
      gender,
      unit: '次',
      audience: oneLine(at(g, r, col('核心针对人群'))).slice(0, 400),
      content: at(g, r, col('服务操作内容')).trim().slice(0, 800),
      highlight: oneLine(at(g, r, col('项目亮点'))).slice(0, 400),
    });
  }
  return out;
}

// ───────────────────────── 整份文件 ─────────────────────────

export interface ParsedPriceCatalog {
  entries: PriceCatalogEntry[];
  issues: PriceImportIssue[];
  notes: Record<string, string>;
}

const PARSERS: Record<PriceSheet, (g: Grid, ctx: Ctx) => PriceCatalogEntry[]> = {
  store: storeSheet,
  entertainment: entertainmentSheet,
  room: roomSheet,
  dish: dishSheet,
  massage: massageSheet,
};

/** 六张表按工作表名认（名字前后的空格不管）；少了哪张报哪张 */
export function parsePriceCatalog(book: XlsxWorkbook): ParsedPriceCatalog {
  const issues: PriceImportIssue[] = [];
  const ctx: Ctx = {
    issues,
    error: (sheet, row, field, message) => issues.push({ sheet: PRICE_SHEET_NAMES[sheet], row, field, message, level: 'error' }),
    warn: (sheet, row, field, message) => issues.push({ sheet: PRICE_SHEET_NAMES[sheet], row, field, message, level: 'warning' }),
  };
  const byName = new Map(book.sheets.map((s) => [s.name.trim(), s]));
  const entries: PriceCatalogEntry[] = [];
  for (const sheet of Object.keys(PARSERS) as PriceSheet[]) {
    const ws = byName.get(PRICE_SHEET_NAMES[sheet]);
    if (!ws) {
      ctx.error(sheet, null, '工作表', `少了「${PRICE_SHEET_NAMES[sheet]}」这张表`);
      continue;
    }
    const grid = gridOf(ws);
    // 行数先核对，再逐行读：原表最多一百多行，几千上万行的不像价目表，整份拒绝（不先建一大堆条目）
    if (grid.size > SHEET_ROWS_MAX) throw new PriceFileError(`「${ws.name}」有 ${grid.size} 行，超过 ${SHEET_ROWS_MAX} 行，不像价目表；请检查表格后再导入`);
    entries.push(...PARSERS[sheet](grid, ctx));
    if (entries.length > ENTRIES_MAX) throw new PriceFileError(`整份价目表认出了 ${entries.length} 项，超过 ${ENTRIES_MAX} 项，不像价目表；请检查表格后再导入`);
  }
  // 一项的分档太多（一格里写了成百上千行）：报错，只留前面的档，后面的校验不再逐档展开
  for (const e of entries) {
    if (e.variants.length > PRICE_VARIANTS_MAX) {
      ctx.error(e.sheet, e.sourceRow, '收费参考', `「${e.name}」认出了 ${e.variants.length} 档价格，超过 ${PRICE_VARIANTS_MAX} 档，请核对这一格`);
      e.variants = e.variants.slice(0, PRICE_VARIANTS_MAX);
    }
  }
  // 最后用页面编辑的同一份校验逐项过一遍（分档时长 0 小时、价格形态与价格不一致……）：导入与编辑一个口径，
  // 导进来的每一项以后都能照常修改。这一行前面已经报过错的不再重复
  const reported = new Set(issues.filter((i) => i.level === 'error').map((i) => `${i.sheet}|${i.row}`));
  // 名称重复：每张表都用页面编辑的同一个查重键（同一张表、同一个板块 / 餐段、同一个分类里，不分大小写、不管空格），
  // 不然导得进、以后改任何一项都被「名称重复」挡住
  const firstRow = new Map<string, number | null>();
  for (const e of entries) {
    const where = `${PRICE_SHEET_NAMES[e.sheet]}|${e.sourceRow}`;
    const key = priceNameKey(e);
    if (e.active && firstRow.has(key)) {
      if (!reported.has(where)) ctx.error(e.sheet, e.sourceRow, '名称', `名称重复：「${e.name}」第 ${firstRow.get(key) ?? '?'} 行已经有了`);
      reported.add(where);
      continue;
    }
    if (e.active) firstRow.set(key, e.sourceRow);
    if (reported.has(where)) continue;
    // 房间的分档都是从表里认出来的金额生成的：价格空着，就是写了但不合法（0 元、多于两位小数……），不当成「没填」
    for (const v of e.sheet === 'room' ? e.variants : []) {
      if (v.priceCents === null) ctx.error(e.sheet, e.sourceRow, '收费参考', `「${e.name}」的「${v.label}」金额不对：要大于 0、按元写、最多两位小数`);
    }
    for (const problem of priceEntryProblems(e)) ctx.error(e.sheet, e.sourceRow, e.name, problem);
  }
  const notes: Record<string, string> = {};
  const sv = byName.get(STORED_VALUE_SHEET_NAME);
  if (sv) {
    const grid = gridOf(sv);
    const text = rowsOf(grid)
      .flatMap((r) => [...(grid.get(r)?.values() ?? [])])
      .map(oneLine)
      .filter((t) => t && t !== STORED_VALUE_SHEET_NAME)
      .join('；');
    if (text) notes[STORED_VALUE_SHEET_NAME] = text.slice(0, 400);
  }
  return { entries, issues, notes };
}
