// 8.1.39 桌台的低消、服务费（docs/V8139.md 第 3 节）：前后端共用。

/** 一次开台此刻的菜钱、低消与服务费（结账核对与结账同一个算法） */
export interface TableCharge {
  tableName: string;
  /** 菜钱：点了、没退、没赠送的明细合计（不算结账时自动记的两行） */
  subtotal: number;
  minSpend: number;
  serviceFeeBp: number;
  /** 服务费 = 菜钱 × 比例，四舍五入到分 */
  serviceFee: number;
  /** 差多少到低消（够了为 0） */
  shortfall: number;
  /** 上次结账自动记的（反结账回来的）：重新结账时作废重算 */
  previousCharges: number;
}

/** 服务费比例最多 30%（万分之 3000） */
export const MAX_SERVICE_FEE_BP = 3000;

/** 1500 → 「服务费 15%」 */
export const serviceFeeText = (bp: number) => `服务费 ${Number((bp / 100).toFixed(2))}%`;
