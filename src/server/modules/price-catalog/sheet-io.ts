// 各模块单独的价目表模板与「按模板导出」（店主 2026-11-24《价目表模板替换与页面维护需求说明》）：
// 门店价格 / 娱乐价格 / 房间价格 / 零点菜品价格 / 按摩及助浴价格各一个文件，格式照店主从总表拆出来的五个表格
// （第 1 行门店名、表头、分类只在组首行写）。导出把页面上改过的价目按同一个格式写回去：导出的文件原样再导入，
// 条目不丢、不重复（tests/price-catalog-sheets.test.ts 逐项核对）。
// 写法与 parse.ts 的读法一一对应：「39/2h」「加钟/19.9」「399/2H起开」「超时199/H」「999封顶」「6小时：999」「S301-S339」……

import { DISH_SECTIONS, PRICE_SHEET_NAMES, STORED_VALUE_SHEET_NAME, type PriceCatalogEntry, type PriceSheet, type PriceVariant } from '@shared/price-catalog';
import type { WbCell, WbSheet } from '../../lib/xlsx';

type Cell = WbCell | string | number | null;

/** 分 → 元（数字；19.9 写成 19.9，不写 19.90） */
const yuan = (cents: number) => cents / 100;
/** 分钟 → 「2H」「90min」 */
const dur = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60}H` : `${minutes}min`);
/** 一天里的分钟 → 「7:30」 */
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

/** 房号清单 → 「S301-S339 Q301 Q305」：同一前缀、同样位数、连着的号写成一段 */
export function roomsText(list: readonly string[]): string {
  const parts: string[] = [];
  let run: { prefix: string; width: number; from: number; to: number } | null = null;
  const flush = () => {
    if (!run) return;
    const f = `${run.prefix}${String(run.from).padStart(run.width, '0')}`;
    parts.push(run.from === run.to ? f : `${f}-${run.prefix}${String(run.to).padStart(run.width, '0')}`);
    run = null;
  };
  for (const no of list) {
    const m = /^([A-Za-z]{1,2})(\d{2,4})$/.exec(no);
    if (!m) {
      flush();
      parts.push(no);
      continue;
    }
    const [, prefix, digits] = m as unknown as [string, string, string];
    const n = Number(digits);
    if (run && run.prefix === prefix && run.width === digits.length && n === run.to + 1) run.to = n;
    else {
      flush();
      run = { prefix, width: digits.length, from: n, to: n };
    }
  }
  flush();
  return parts.join(' ');
}

const head = (cells: string[]) => ({ height: 22, cells: cells.map((v) => ({ v, style: 'optional' as const })) });
const banner = (v: string, span: number) => ({ height: 28, cells: [{ v, style: 'title' as const }, ...Array.from({ length: span - 1 }, () => null)] });
const row = (cells: Cell[]) => ({ cells: cells.map((c) => (c === '' ? null : c)) });
const live = (entries: PriceCatalogEntry[], sheet: PriceSheet) => entries.filter((e) => e.sheet === sheet && e.active).sort((a, b) => a.sortOrder - b.sortOrder);

// ───────────────────────── 门店价格 ─────────────────────────

function storeRows(entries: PriceCatalogEntry[]): Cell[][] {
  const out: Cell[][] = [];
  let last = '';
  for (const e of live(entries, 'store')) {
    const type = e.kind === 'ticket' ? '门票' : e.kind === 'night_ticket' ? '夜间票' : e.kind === 'meal_ticket' ? '餐票' : '服务费';
    // 类型只在组首行写（与门店的表格一样），导入时留空沿用上一行
    const t = type === last ? '' : type;
    last = type;
    if (e.kind === 'service_fee') {
      out.push([t, '服务费', `${(e.rateBp ?? 0) / 100}%`, e.note, '']);
    } else if (e.kind === 'ticket') {
      // 是否含餐照备注认：备注与「含餐」对不上的补一句，导回来还是这个样子
      const saysMeal = /含/.test(e.note) && !/不含/.test(e.note);
      const note = e.includesMeal && !saysMeal ? `含餐；${e.note}` : !e.includesMeal && saysMeal ? `不含餐；${e.note}` : e.note;
      out.push([t, e.durationMinutes !== null ? dur(e.durationMinutes) : '', e.priceCents !== null ? yuan(e.priceCents) : '', note.replace(/；$/, ''), '']);
    } else if (e.kind === 'night_ticket') {
      out.push([t, e.windowStart !== null && e.windowEnd !== null ? `${hm(e.windowStart)}-${hm(e.windowEnd)}` : '', e.priceCents !== null ? yuan(e.priceCents) : '', e.note, '']);
    } else {
      out.push([t, e.name, e.priceCents !== null ? yuan(e.priceCents) : '', e.note, e.windowStart !== null && e.windowEnd !== null ? `${hm(e.windowStart)}--${hm(e.windowEnd)}` : '']);
    }
  }
  return out;
}

// ───────────────────────── 娱乐价格 ─────────────────────────

function entertainmentRows(entries: PriceCatalogEntry[]): Cell[][] {
  return live(entries, 'entertainment').map((e) => {
    const base = e.priceCents !== null ? yuan(e.priceCents) : '';
    const price = e.durationMinutes !== null && base !== '' ? `${base}/${dur(e.durationMinutes).toLowerCase()}` : base;
    const note = [e.note, e.extraPriceCents !== null ? `加钟/${yuan(e.extraPriceCents)}` : ''].filter(Boolean).join(' ');
    return [e.name, e.unitsCount ?? '', price, note];
  });
}

// ───────────────────────── 房间价格 ─────────────────────────

/** 一项房型 → 表里的几行：[房型, 总数, 收费参考, 超时 / 封顶 / 另一档, 备注, 开瓶费等说明] */
function roomEntryRows(e: PriceCatalogEntry): Cell[][] {
  const units = e.unitsCount !== null ? `${e.unitsCount}间` : '';
  const y = (c: number | null) => (c === null ? '' : String(yuan(c)));
  if (/轰趴/.test(e.name)) {
    // 一个面积一行：6 / 12 小时与包天的价、面积（房号）几人位
    const groups = new Map<string, PriceVariant[]>();
    for (const v of e.variants) {
      const area = /^(\d+)平 /.exec(v.label)?.[1] ?? '';
      groups.set(area, [...(groups.get(area) ?? []), v]);
    }
    return [...groups].map(([area, vs], i) => {
      const prices = vs.map((v) => (v.minutes === null ? `包天：${y(v.priceCents)}` : `${v.minutes / 60}小时：${y(v.priceCents)}`)).join('\n');
      const seats = vs.find((v) => v.seats)?.seats;
      const rooms = roomsText(vs.find((v) => v.roomNumbers?.length)?.roomNumbers ?? []);
      const desc = [area ? `${area}平${rooms ? `（${rooms})` : ''}` : rooms, seats ? `${seats}人位` : ''].filter(Boolean).join(' ');
      return [e.name, i === 0 ? units : '', prices, '', desc, i === 0 ? e.note : ''];
    });
  }
  if (/餐饮包房/.test(e.name)) {
    const lines = [
      ...e.variants.filter((v) => v.unit === '位').map((v) => `${y(v.priceCents)}元/位`),
      // 低消照导入时记下的原话（「低销：6888元起」）；页面上改了价的用新价
      ...e.variants.filter((v) => v.label === '低消').map((v) => (v.note && v.note.includes(String(y(v.priceCents))) ? v.note : `低消：${y(v.priceCents)}元起`)),
      ...(e.extraPriceCents !== null ? [`超出按照${y(e.extraPriceCents)}元/小时收费。`] : []),
    ];
    return [[e.name, units, lines.join('\n'), '', roomsText(e.roomNumbers), e.note]];
  }
  if (/客房/.test(e.name)) {
    const nights = e.variants.filter((v) => v.unit === '晚').map((v) => `${v.label.replace(/\s*过夜$/, '')} ${y(v.priceCents)}/晚`.trim());
    const hours = e.variants.filter((v) => v.unit !== '晚' && v.minutes !== null).map((v) => `${y(v.priceCents)}/${v.minutes! / 60}小时`);
    return [[e.name, units, nights.join('\n'), hours.join('\n'), roomsText(e.roomNumbers), '']];
  }
  const start = e.priceCents !== null && e.durationMinutes !== null ? `${y(e.priceCents)}/${dur(e.durationMinutes)}起开` : y(e.priceCents);
  const rule = [
    e.extraPriceCents !== null && e.extraMinutes ? `超时${y(e.extraPriceCents)}/${e.extraMinutes === 60 ? '' : e.extraMinutes / 60}H` : '',
    ...e.variants.filter((v) => v.minutes !== null).map((v) => `${y(v.priceCents)}/${v.minutes! / 60}H`),
    e.capCents !== null ? `${y(e.capCents)}封顶` : '',
  ].filter(Boolean);
  // 备注第一行是房号（导入时只从第一行认房号），说明写在后面几行；没有房号时第一行写「—」占位
  const note = [roomsText(e.roomNumbers) || (e.note ? '—' : ''), e.note].filter(Boolean).join('\n');
  return [[e.name, units, start, rule.join('\n'), note, '']];
}

const roomRows = (entries: PriceCatalogEntry[]) => live(entries, 'room').flatMap(roomEntryRows);

// ───────────────────────── 零点菜品价格 ─────────────────────────

const DISH_TITLES: Record<(typeof DISH_SECTIONS)[number], string> = {
  '2楼零点': '2楼餐厅零点菜品',
  早餐: '早餐自助零点菜品',
  午餐: '午餐自助零点菜品',
  晚餐: '晚餐自助零点菜品',
};
const DISH_HEAD = ['序号', '菜品分类', '菜品名称', '售价', '单位'];

function dishSheet(entries: PriceCatalogEntry[], withEmpty: boolean): Pick<WbSheet, 'rows' | 'merges'> {
  const rows: WbSheet['rows'] = [];
  const merges: string[] = [];
  const dishes = live(entries, 'dish');
  for (const section of DISH_SECTIONS) {
    const mine = dishes.filter((d) => d.section === section);
    if (!mine.length && !withEmpty) continue;
    rows.push(banner(DISH_TITLES[section], 5));
    merges.push(`A${rows.length}:E${rows.length}`);
    rows.push(head(DISH_HEAD));
    let last = '';
    for (const d of mine) {
      rows.push(row([d.code, d.category === last ? '' : d.category, d.name, d.priceCents !== null ? yuan(d.priceCents) : '', d.unit]));
      last = d.category;
    }
    if (!mine.length) rows.push({ cells: [] });
  }
  return { rows, merges };
}

// ───────────────────────── 按摩及助浴价格 ─────────────────────────

const MASSAGE_HEAD = ['板块分类', '编号', '项目名称', '类型', '时长', '专业价', '资深价', '核心针对人群', '服务操作内容', '项目亮点'];
const VENUE_TEXT = { room: '房间', lobby: '大堂', bath: '浴区' } as const;

function massageRows(entries: PriceCatalogEntry[]): Cell[][] {
  let last = '';
  return live(entries, 'massage').map((e) => {
    const section = e.section === last ? '' : e.section;
    last = e.section;
    // 「资深价」一列：双价写资深价；只有专业价的写适用性别（助浴「女」「男/女」，名称带「女宾」的不用写）
    const second =
      e.priceMode === 'dual' && e.price2Cents !== null
        ? yuan(e.price2Cents)
        : e.gender === 'any'
          ? '男/女'
          : e.gender === 'female' && !/女宾/.test(e.name)
            ? '女'
            : e.gender === 'male' && !/男宾/.test(e.name)
              ? '男'
              : '';
    return [
      section,
      e.code,
      e.name,
      e.venues.map((v) => VENUE_TEXT[v]).join('/'),
      e.durationMinutes !== null ? `${e.durationMinutes}min` : '',
      e.priceCents !== null ? yuan(e.priceCents) : '',
      second,
      e.audience,
      e.content,
      e.highlight,
    ];
  });
}

// ───────────────────────── 一张表 ─────────────────────────

/** 一张表的工作表：entries 为空就是导入模板（表头照门店的表格、数据留空） */
export function priceSheet(sheet: PriceSheet, entries: PriceCatalogEntry[], storeName: string): WbSheet {
  const name = PRICE_SHEET_NAMES[sheet];
  const title = storeName || name;
  if (sheet === 'store') {
    return { name, widths: [10, 16, 10, 24, 28], rows: [banner(title, 5), head(['类型', '项目', '价格', '备注', '时间']), ...storeRows(entries).map(row)], merges: ['A1:E1'] };
  }
  if (sheet === 'entertainment') {
    return { name, widths: [14, 8, 12, 18], rows: [banner(title, 4), head(['类型', '数量', '价格', '备注']), ...entertainmentRows(entries).map(row)], merges: ['A1:D1'] };
  }
  if (sheet === 'room') {
    return { name, widths: [12, 8, 26, 20, 34, 34], rows: [head(['房型', '总数', '收费参考', '', '备注', '']), ...roomRows(entries).map(row)] };
  }
  if (sheet === 'dish') {
    return { name, widths: [6, 12, 30, 8, 6], ...dishSheet(entries, entries.length === 0) };
  }
  return { name, widths: [10, 6, 22, 10, 8, 8, 8, 30, 30, 30], rows: [head(MASSAGE_HEAD), ...massageRows(entries).map(row)] };
}

/** 整份（五张表 + 储值政策那一句）：与六张表的总模板同一个格式 */
export function priceSheets(entries: PriceCatalogEntry[], storeName: string, notes: Record<string, string>): WbSheet[] {
  const sheets: WbSheet[] = (['store', 'entertainment', 'room', 'dish', 'massage'] as const).map((s) => priceSheet(s, entries, storeName));
  sheets.push({ name: STORED_VALUE_SHEET_NAME, widths: [40], rows: [banner(STORED_VALUE_SHEET_NAME, 1), ...(notes[STORED_VALUE_SHEET_NAME] ? [row([notes[STORED_VALUE_SHEET_NAME]])] : [])] });
  sheets[0]!.active = true;
  return sheets;
}
