// 8.2.3 前台（发卡台与全店，docs/V8223_FRONTDESK.md）：会议纪要《会所管理系统演示与需求讨论》（2026-11-26）里前台的九条。
// 前后端共用的规则、类型与小函数。金额为分。
//   · 客人类别（普通、港客、外宾、儿童，后台可加）；
//   · 客人偏好（忌口、按摩力度、其他，后台可加）：会员的跟着会员走，散客的跟着这一次来访；
//   · 客诉台账：带「客诉」「特殊关照」标签的前台备注汇总、标已处理、打印；
//   · 区域拥挤提示：连续往同一区发了 N 张、或一个区在店超过 M 人时提示换区；
//   · 高风险提示：在店超过 X 小时、或挂账超过 Y 元时标红、进提醒列表，按设定推给值班经理或店总；
//   · 补单：按实际时间、出单员补录餐饮与项目（不打厨房单），明细上标「补单」。

import { tagArea, type TagZone } from './frontdesk';
import { formatYuan } from './money';

// ───────────── 规则（后台「手牌与前台 → 客人与提醒」） ─────────────

/** 客人偏好的一项自定义字段：key 是英文小写编号（存值用，改名不丢值），label 是显示的名字 */
export interface GuestPrefField {
  key: string;
  label: string;
}

/** 高风险提示推给谁：只在页面上标、推给值班经理（及以上）、推给店总（及店主） */
export const RISK_NOTIFY_LEVELS = ['page', 'duty_manager', 'store_manager'] as const;
export type RiskNotifyLevel = (typeof RISK_NOTIFY_LEVELS)[number];
export const RISK_NOTIFY_LABELS: Record<RiskNotifyLevel, string> = {
  page: '只在页面上提示',
  duty_manager: '推给值班经理、店总、店主',
  store_manager: '推给店总、店主',
};

export interface GuestRules {
  /** 客人类别；第一项是默认（「普通」），发牌时不选就是它，手牌上不标 */
  categories: string[];
  /** 客人偏好的字段 */
  prefFields: GuestPrefField[];
  /** 进客诉台账的备注标签（与数据字典「前台备注的标签」里的字一致） */
  complaintTags: string[];
  /** 区域拥挤提示：连续往同一区发了几张后提示（0 = 不按这个提示）；一个区在店超过几人提示（0 = 不按这个提示） */
  crowd: { streak: number; areaMax: number };
  /** 高风险提示：在店超过几小时（0 = 不按时长）、挂账超过多少分（0 = 不按金额）；推给谁 */
  risk: { stayHours: number; amountCents: number; notify: RiskNotifyLevel };
}

export const DEFAULT_GUEST_RULES: GuestRules = {
  categories: ['普通', '港客', '外宾', '儿童'],
  prefFields: [
    { key: 'diet', label: '忌口' },
    { key: 'massage', label: '按摩力度' },
    { key: 'other', label: '其他' },
  ],
  complaintTags: ['客诉', '特殊关照'],
  crowd: { streak: 10, areaMax: 0 },
  risk: { stayHours: 24, amountCents: 200_000, notify: 'page' },
};

export const MAX_GUEST_CATEGORIES = 12;
export const MAX_CATEGORY_LENGTH = 8;
export const MAX_PREF_FIELDS = 8;
export const MAX_PREF_LABEL = 8;
export const MAX_PREF_VALUE = 60;
export const PREF_KEY_PATTERN = /^[a-z][a-z0-9_]{0,19}$/;
/** 发牌时写的预约技师（记成一条带「预约技师」标签的单人备注） */
export const BOOKED_TECH_TAG = '预约技师';
export const MAX_BOOKED_TECH = 40;

/** 客人类别要不要在手牌上标：默认类别（第一项）不标 */
export function categoryMark(category: string | null | undefined, rules: Pick<GuestRules, 'categories'>): string | null {
  if (!category) return null;
  return category === rules.categories[0] ? null : category;
}

// ───────────── 区域拥挤提示 ─────────────

/** 板上的一张牌（只要算拥挤用的几项） */
export interface CrowdTag {
  code: string;
  zone: TagZone;
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  serviceStatus: string;
  visit: { checkedInAt: string } | null;
}

export interface CrowdAdvice {
  area: string;
  /** 这个区现在在店几人（不算这一张） */
  inArea: number;
  /** 最近连续发到这个区的几张（同一分区里按发牌时刻倒着数，不算这一张） */
  streak: number;
  /** 提示的一句话 */
  text: string;
  /** 建议改发哪个区（同一分区里在店最少、还有空牌的普通柜区）；没有更好的为 null */
  suggest: string | null;
}

/**
 * 往这张牌发之前要不要提示换区：普通柜按区号（A、B…）算，VIP 柜不提示。
 * 连续：同一分区（男宾 / 女宾）在店的客人按发牌时刻倒着数，连着几张都在这个区；区里人多：这个区在店的人数。
 * 两个阈值都是 0 时不提示。返回 null = 不用提示
 */
export function crowdAdvice(tags: readonly CrowdTag[], code: string, rules: Pick<GuestRules, 'crowd'>): CrowdAdvice | null {
  const { streak: maxStreak, areaMax } = rules.crowd;
  if (maxStreak <= 0 && areaMax <= 0) return null;
  const target = tags.find((t) => t.code === code);
  if (!target || target.kind === 'vip') return null;
  const area = tagArea(code);
  const sameZone = tags.filter((t) => t.zone === target.zone && t.kind === 'normal');
  const inStore = sameZone.filter((t) => t.visit).sort((a, b) => (a.visit!.checkedInAt < b.visit!.checkedInAt ? 1 : -1));
  let streak = 0;
  for (const t of inStore) {
    if (tagArea(t.code) !== area) break;
    streak += 1;
  }
  const inArea = inStore.filter((t) => tagArea(t.code) === area).length;
  const byStreak = maxStreak > 0 && streak >= maxStreak;
  const byCount = areaMax > 0 && inArea >= areaMax;
  if (!byStreak && !byCount) return null;
  const label = area ? `${area} 区` : '普通柜';
  // 建议：同一分区里别的区，有空牌、在店最少
  const areas = new Map<string, { free: number; inStore: number }>();
  for (const t of sameZone) {
    const a = tagArea(t.code);
    const s = areas.get(a) ?? { free: 0, inStore: 0 };
    if (t.visit) s.inStore += 1;
    else if (t.active && !t.locked && t.serviceStatus === 'normal') s.free += 1;
    areas.set(a, s);
  }
  const better = [...areas.entries()]
    .filter(([a, s]) => a !== area && s.free > 0 && s.inStore < inArea && (areaMax <= 0 || s.inStore < areaMax))
    .sort((x, y) => x[1].inStore - y[1].inStore || x[0].localeCompare(y[0]))[0];
  const why = [byStreak ? `已连续往${label}发了 ${streak} 张` : '', byCount ? `${label}在店 ${inArea} 人` : ''].filter(Boolean).join('，');
  return {
    area,
    inArea,
    streak,
    text: `${why}，换衣处可能拥挤，建议换区发牌${better ? `（${better[0] ? `${better[0]} 区` : '普通柜'}在店 ${better[1].inStore} 人）` : ''}`,
    suggest: better ? better[0] : null,
  };
}

// ───────────── 高风险提示 ─────────────

export type RiskReason = 'stay' | 'amount';
export const RISK_REASON_LABELS: Record<RiskReason, string> = { stay: '在店时间长', amount: '消费金额大' };

export interface HighRisk {
  reasons: RiskReason[];
  /** 小标上的字：「高风险 · 超 24 小时」「高风险 · 挂账超 ¥2,000.00」 */
  text: string;
}

/** 一位在店客人现在算不算高风险（在店分钟、挂账金额）；不算返回 null */
export function highRiskOf(stayMinutes: number, amountCents: number, rules: Pick<GuestRules, 'risk'>): HighRisk | null {
  const reasons: RiskReason[] = [];
  const { stayHours, amountCents: limit } = rules.risk;
  if (stayHours > 0 && stayMinutes >= stayHours * 60) reasons.push('stay');
  if (limit > 0 && amountCents >= limit) reasons.push('amount');
  if (!reasons.length) return null;
  const parts = reasons.map((r) => (r === 'stay' ? `超 ${stayHours} 小时` : `挂账超 ${formatYuan(limit)}`));
  return { reasons, text: `高风险 · ${parts.join('、')}` };
}

/** 推送里的一句话 */
export const riskAlertText = (tagCode: string, reason: RiskReason, rules: Pick<GuestRules, 'risk'>) =>
  `手牌 ${tagCode} ${reason === 'stay' ? `在店超过 ${rules.risk.stayHours} 小时` : `挂账超过 ${formatYuan(rules.risk.amountCents)}`}，请去看看客人、提醒结账，防止跑单`;

// ───────────── 接口返回 ─────────────

/** 一位客人的偏好与类别（客人卡、全店刷手牌的地方） */
export interface GuestProfile {
  category: string;
  /** 偏好记在哪：会员的跟着会员走（下次来自动带出），散客的跟着这次来访 */
  owner: 'member' | 'visit';
  /** 按后台字段的顺序；没填的 value 为空字符串。字段停用了但以前填过的也列出（retired = true） */
  prefs: { key: string; label: string; value: string; retired: boolean; updatedByName: string | null; updatedAt: string | null }[];
}

/** 全店刷手牌的地方看的一条（点单、房态、钟房派钟）：类别、偏好、没撤下的备注 */
export interface GuestNotes {
  visitId: number;
  tagCode: string;
  category: string;
  categoryMark: string | null;
  prefs: { label: string; value: string }[];
  remarks: { tag: string; note: string; scope: 'single' | 'group' }[];
  highRisk: HighRisk | null;
}

/** 客诉台账的一行 */
export interface ComplaintRow {
  remarkId: number;
  storeName: string;
  businessDate: string;
  tag: string;
  note: string;
  scope: 'single' | 'group';
  tagCode: string;
  visitNo: string;
  visitId: number;
  guest: string;
  createdByName: string;
  createdAt: string;
  /** 撤下了的照旧列出（划掉） */
  removed: boolean;
  resolved: { note: string; byName: string; at: string } | null;
}

export const COMPLAINT_STATUSES = ['open', 'resolved', 'all'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export const COMPLAINT_STATUS_LABELS: Record<ComplaintStatus, string> = { open: '没处理', resolved: '已处理', all: '全部' };

/** 客诉台账的接口地址（台账页与打印页同一个） */
export const complaintsPath = (from: string, to: string, status: ComplaintStatus) => `/api/frontdesk/complaints?from=${from}&to=${to}&status=${status}`;

export interface ComplaintLedger {
  rows: ComplaintRow[];
  /** 超过 500 条只列前 500 条 */
  truncated: boolean;
  tags: string[];
}

/** 高风险提醒列表的一行（在店、现在超了阈值的客人） */
export interface RiskAlertRow {
  visitId: number;
  tagCode: string;
  zone: TagZone;
  guest: string;
  checkedInAt: string;
  amountCents: number;
  risk: HighRisk;
  /** 推送过几次（每位客人每一样只推一次） */
  notified: RiskReason[];
}

/** 补单的出单员候选 */
export interface SupplementIssuer {
  id: number;
  name: string;
}
