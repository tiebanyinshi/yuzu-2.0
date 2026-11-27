// 8.2.10 休闲娱乐（docs/V82210_LEISURE.md）：网吧、桌球等按台位开单计时，前后端共用。

/** 价目表里的一种娱乐（「娱乐价格」表按时长收费的那几行）按什么建台位与计费 */
export interface LeisurePlanRow {
  /** 价目表里的名称（就是业态名，最多 8 字） */
  name: string;
  /** 对接的收银项目（价目表切换生效时建的）；没有的建不了计费 */
  itemId: number | null;
  itemName: string | null;
  /** 基础价（分）与含的时长（分钟） */
  basePrice: number;
  minMinutes: number;
  /** 加钟价（分，每 stepMinutes 分钟）；价目表没写加钟时按基础价折算每小时价 */
  extraPrice: number;
  stepMinutes: number;
  extraGuessed: boolean;
  /** 价目表写的台数、台账里这个业态已有的台位数 */
  units: number;
  existing: number;
  /** 建台位用的编码前缀（大写字母开头） */
  prefix: string;
  /** 建不了的原因（没对接收银项目、时长超过 10 小时……）；能建为 null */
  problem: string | null;
}

export interface LeisurePlan {
  catalogTitle: string | null;
  floors: { id: number; code: string; name: string }[];
  rows: LeisurePlanRow[];
}

export interface LeisureSetupResult {
  types: string[];
  created: string[];
  /** 编码已经有了（同一业态的不重复建；别的业态占用的也跳过） */
  skipped: { code: string; reason: string }[];
}

/** 常见娱乐的编码前缀；别的按 E + 序号字母 */
const PREFIXES: Record<string, string> = { 网吧: 'NB', 电竞: 'DJ', 桌球: 'ZQ', 台球: 'TQ', 棋牌: 'QP', 麻将: 'MJ', 电玩: 'DW', 乒乓球: 'PP', 飞镖: 'FB' };
export function leisurePrefix(name: string, index: number): string {
  const hit = Object.entries(PREFIXES).find(([k]) => name.includes(k));
  return hit ? hit[1] : `E${String.fromCharCode(65 + (index % 26))}`;
}

/** 台位编码：前缀 + 两位序号（NB01） */
export const leisureCode = (prefix: string, n: number) => `${prefix}${String(n).padStart(2, '0')}`;
