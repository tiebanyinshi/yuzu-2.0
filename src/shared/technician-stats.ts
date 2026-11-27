// 技师统计（8.2.2，《技师排班系统需求沟通会》五.1；docs/V8222_TECHNICIANS.md 第 7 节）：每天的扩钟数、每 10 天一段的总业绩（按工种小计）、
// 每月业绩任务（按技师或按组设目标，看完成度）。业绩的口径与「技师业绩」相同（结账那一刻的技师明细，时段内反结账的冲回）；
// 扩钟数按挂账（没作废的扩钟明细，不含加钟，客人还没结账的也算），当天就能看。

/** 一次最多看几天的扩钟 */
export const MAX_CALL_STAT_DAYS = 62;

export interface CallStatRow {
  technicianId: number;
  techNo: string;
  name: string;
  /** 营业日 → 扩钟数 */
  days: Record<string, number>;
  total: number;
}

export interface CallStats {
  from: string;
  to: string;
  dates: string[];
  rows: CallStatRow[];
  /** 每天全店的扩钟数 */
  totals: Record<string, number>;
  total: number;
}

/** 一段（1–10 日、11–20 日、21 日到月底）里一位技师的业绩 */
export interface PeriodTechRow {
  technicianId: number;
  techNo: string;
  name: string;
  kind: string;
  clocks: number;
  call: number;
  extension: number;
  amount: number;
}

export interface PeriodKind {
  /** 工种（技师档案的「类型」）；没设的是空字符串 */
  kind: string;
  clocks: number;
  amount: number;
  rows: PeriodTechRow[];
}

export interface PeriodSegment {
  label: string;
  from: string;
  to: string;
  kinds: PeriodKind[];
  total: { clocks: number; amount: number };
}

export interface PeriodStats {
  month: string;
  segments: PeriodSegment[];
  total: { clocks: number; amount: number };
}

/** 每 10 天一段：1–10、11–20、21 到月底（31 天的月份最后一段 11 天，2 月 8 或 9 天） */
export function monthSegments(month: string): { label: string; from: string; to: string }[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = (n: number) => `${month}-${String(n).padStart(2, '0')}`;
  return [
    { label: '1–10 日', from: d(1), to: d(10) },
    { label: '11–20 日', from: d(11), to: d(20) },
    { label: `21–${last} 日`, from: d(21), to: d(last) },
  ];
}

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface TechTarget {
  technicianId: number | null;
  groupId: number | null;
  /** 技师「08 号 小李」或组名 */
  label: string;
  /** 目标金额（分） */
  amount: number;
  /** 目标钟数；没设为 null */
  clocks: number | null;
  actualAmount: number;
  actualClocks: number;
  /** 金额完成度（百分比，整数；目标为 0 时为 null） */
  rate: number | null;
}

export interface TargetView {
  month: string;
  /** 算到哪天（本月算到今天，以前的月份算到月底） */
  through: string;
  targets: TechTarget[];
  updatedAt: string | null;
  updatedBy: string | null;
}
