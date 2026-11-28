// 日期、时间与文字（按门店的时区 Asia/Shanghai 显示；数字用等宽，见 app.wxss 的 .num）。

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const TZ_OFFSET_MIN = 8 * 60;

/** 门店时区的「现在」拆开：年月日、时分、星期 */
export function storeClock(at: Date = new Date()): { date: string; hour: number; minute: number; weekday: number } {
  const t = new Date(at.getTime() + TZ_OFFSET_MIN * 60000);
  const date = t.toISOString().slice(0, 10);
  return { date, hour: t.getUTCHours(), minute: t.getUTCMinutes(), weekday: t.getUTCDay() };
}

/** 早上好 / 中午好 / 下午好 / 晚上好（按门店时区） */
export function greeting(at: Date = new Date()): string {
  const h = storeClock(at).hour;
  if (h >= 5 && h < 11) return '早上好';
  if (h >= 11 && h < 14) return '中午好';
  if (h >= 14 && h < 18) return '下午好';
  return '晚上好';
}

/** 2026-11-27 → 11 月 27 日 · 星期五 */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return `${m} 月 ${d} 日 · 星期${WEEK[wd]}`;
}

/** 一天里的分钟数 → 09:05（跨天的 24:30 写成次日 00:30） */
export function hhmm(minuteOfDay: number): string {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  const text = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return minuteOfDay >= 1440 ? `次日 ${text}` : text;
}

/** ISO 时间 → 门店时区的「11-27 09:05」；今天的只写「09:05」 */
export function shortTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (isNaN(at.getTime())) return '';
  const c = storeClock(at);
  const today = storeClock(now).date;
  const t = `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
  return c.date === today ? t : `${c.date.slice(5)} ${t}`;
}

/** 文件大小：1.2 MB、860 KB */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 姓名的首字（头像上写的） */
export function initialOf(name: string): string {
  const t = (name || '').trim();
  return t ? t.charAt(0) : '·';
}
