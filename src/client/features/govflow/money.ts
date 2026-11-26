// 业财法页面共用：元（最多两位小数）→ 分。

export function yuanToCents(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [int, frac = ''] = t.split('.');
  return Number(int) * 100 + Number(frac.padEnd(2, '0'));
}
