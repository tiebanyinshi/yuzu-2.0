// 轮班周期（8.1.41，docs/V8141_ROTA.md；店主《门店系统需求梳理与优化方案》2026-11-25「自定义轮班」）：
//   门店自己定一份轮班：几段，每段几天、上哪个班（或休息），按哪种口径转班，再按它给选中的技师生成排班表。
//   · 按周期轮转（cycle）：从起算日开始，各段首尾相接一直重复（起算日以前也按同一个节奏往回推）；7 天一轮、10 天一转都用它。
//   · 每月 1 日固定转班（monthly）：每个月 1 日从第一段重新开始，各段依次排；排完了还没到月底的，月底前都按最后一段
//     （10／10／10 遇上 31 天的月份，第三段多排一天；2 月只有 28 天，第三段排到 28 日为止）。
//   两种口径在大小月下会冲突（店主的风险提示），所以一份轮班只选一种，不混用。
//   每位技师可以错开几段（offset）：同一份轮班，三位中医技师分别从第一、二、三段开始。
// 这里只算格子（纯函数，前后端共用）；写进排班表走排班的同一条路（technician-admin.ts）。

export const ROTA_MODES = ['cycle', 'monthly'] as const;
export type RotaMode = (typeof ROTA_MODES)[number];
export const ROTA_MODE_LABELS: Record<RotaMode, string> = { cycle: '按周期轮转', monthly: '每月 1 日固定转班' };
export const ROTA_MODE_HINTS: Record<RotaMode, string> = {
  cycle: '从起算日开始，各段首尾相接一直重复，不看大小月。适合 7 天一轮这类固定天数的。',
  monthly: '每月 1 日从第一段重新开始；各段排完还没到月底的，按最后一段排到月底（31 天的月份最后一段多一天，2 月最后一段少几天）。',
};

export const MAX_ROTA_NAME = 16;
export const MAX_ROTAS = 30;
export const MAX_ROTA_SEGMENTS = 12;
export const MAX_SEGMENT_DAYS = 31;
/** 一次按轮班生成排班最多几位技师 */
export const ROTA_APPLY_MAX_TECHS = 50;

export interface RotaSegment {
  /** 这一段几天（1–31） */
  days: number;
  /** 上哪个班；null 是休息（排休） */
  shiftId: number | null;
}

export interface TechRota {
  id: number;
  name: string;
  mode: RotaMode;
  /** 按周期轮转的起算日（第一段的第一天）；每月 1 日固定转班不用，存 null */
  anchor: string | null;
  segments: RotaSegment[];
}

export interface RotaCell {
  /** 落在第几段（从 0 起，按原来的顺序，不算错开） */
  segment: number;
  shiftId: number | null;
  rest: boolean;
}

/** 日期（YYYY-MM-DD）→ 从 1970-01-01 起的第几天 */
const dayNumber = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};
const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * 这份轮班在这一天排什么。offset：这位技师错开几段（正数往后错，可以是负数；超过段数的按段数取余）。
 * 按周期轮转：错开 k 段 = 从第 k 段开始首尾相接；每月 1 日固定转班：每月 1 日从第 k 段开始，排完了按（错开后的）最后一段。
 */
export function rotaCellOn(rota: Pick<TechRota, 'mode' | 'anchor' | 'segments'>, date: string, offset = 0): RotaCell {
  const n = rota.segments.length;
  if (n === 0) throw new Error('轮班至少要有一段');
  const start = mod(offset, n);
  const order = Array.from({ length: n }, (_, i) => (start + i) % n);
  let pos: number;
  if (rota.mode === 'monthly') {
    pos = Number(date.slice(8, 10)) - 1;
  } else {
    if (!rota.anchor) throw new Error('按周期轮转要有起算日');
    const total = rota.segments.reduce((s, g) => s + g.days, 0);
    pos = mod(dayNumber(date) - dayNumber(rota.anchor), total);
  }
  let picked = order[n - 1]!;
  for (const i of order) {
    if (pos < rota.segments[i]!.days) {
      picked = i;
      break;
    }
    pos -= rota.segments[i]!.days;
  }
  const seg = rota.segments[picked]!;
  return { segment: picked, shiftId: seg.shiftId, rest: seg.shiftId === null };
}

/** 一轮几天（各段加起来） */
export const rotaTotalDays = (rota: Pick<TechRota, 'segments'>) => rota.segments.reduce((s, g) => s + g.days, 0);

/** 「10 天 中医早班 → 10 天 中医晚班 → 10 天 休息」 */
export function rotaSummary(rota: Pick<TechRota, 'segments'>, shiftName: (id: number) => string): string {
  return rota.segments.map((g) => `${g.days} 天 ${g.shiftId === null ? '休息' : shiftName(g.shiftId)}`).join(' → ');
}
