// 买单时查会员、现场建档（8.1.44，《前台系统开发》「支持买单时即席建档并查询会员身份」，docs/V8144_FRONTDESK.md 第 5 条）。
// 收银台按手机号（姓名、会员号也行）查这位客人是不是会员、充没充过值、现在有多少余额，免得客人不知道、漏用余额；
// 查到的、当场新建的会员可以记到这张手牌上，这次结账就能用他的储值、会员折扣与券。

/** 查到的一位会员：档案、余额、充值记录的汇总、此刻在不在店 */
export interface CashierMemberHit {
  id: number;
  memberNo: string;
  name: string;
  phone: string | null;
  status: 'active' | 'frozen';
  /** 已合并到别的会员（这份档案停用） */
  merged: boolean;
  principalBalance: number;
  bonusBalance: number;
  /** 充过几次值、一共实收多少（分）、最近一次是什么时候；没充过为 0 / null */
  rechargeCount: number;
  rechargePaid: number;
  lastRechargeAt: string | null;
  /** 此刻在店的手牌（已经记在别的手牌上了）；不在店为 null */
  openTagCode: string | null;
  openVisitId: number | null;
}

/** 给收银员看的一句话：有没有余额、充没充过值，提醒别漏用 */
export function memberBalanceHint(m: Pick<CashierMemberHit, 'principalBalance' | 'bonusBalance' | 'rechargeCount'>): { tone: 'pine' | 'neutral'; text: string } {
  const balance = m.principalBalance + m.bonusBalance;
  if (balance > 0) return { tone: 'pine', text: m.rechargeCount > 0 ? `充过 ${m.rechargeCount} 次值，还有余额，记到手牌上就能用储值付` : '有余额（老卡迁移或调整来的），记到手牌上就能用储值付' };
  return { tone: 'neutral', text: m.rechargeCount > 0 ? `充过 ${m.rechargeCount} 次值，余额已经用完` : '没充过值' };
}
