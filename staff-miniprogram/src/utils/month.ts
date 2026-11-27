// 月份：2026-11 加减几个月、写成「2026 年 11 月」；某一天写成「27 日 周五」。

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  return `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`;
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export function dayOfMonthLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} 日 周${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}

/** 一天里的分钟 → 09:00；跨天的下班写「次日 02:00」 */
export function shiftRange(startMinute: number, endMinute: number): string {
  const t = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${t(startMinute)}–${endMinute <= startMinute || endMinute >= 1440 ? '次日 ' : ''}${t(endMinute % 1440)}`;
}
