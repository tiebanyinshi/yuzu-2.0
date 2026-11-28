// 金额（分）→「1,280.00」：小程序里只显示，不算钱（AGENTS.md：金额一律整数分）。

export function yuan(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const int = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${int}.${String(abs % 100).padStart(2, '0')}`;
}

/** 输入的「12.5」元 → 1250 分；不是合法金额返回 null */
export function centsOf(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
