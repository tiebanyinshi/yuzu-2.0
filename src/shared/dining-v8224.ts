// 8.2.4 餐饮（会议纪要「餐饮系统需求对接会」，docs/V8224_DINING.md）：前后端共用。
//   · 包房房型：低消、中消、只收房费；桌台的低消、服务费按「桌台自己设的 → 房型 → 门店默认」取；
//   · 公司承担的原因；
//   · 菜单分组默认档口的核对行。

/** 房型怎么收：按低消（不够的补足或返台）/ 只收房费（不设低消） */
export const ROOM_CHARGE_MODES = ['min_spend', 'room_fee'] as const;
export type RoomChargeMode = (typeof ROOM_CHARGE_MODES)[number];
export const ROOM_CHARGE_MODE_LABELS: Record<RoomChargeMode, string> = { min_spend: '按低消', room_fee: '只收房费' };

/** 房型名最多 12 个字、一家店最多 20 个房型 */
export const MAX_ROOM_TYPE_NAME = 12;
export const MAX_ROOM_TYPES = 20;

export interface DiningRoomType {
  id: number;
  name: string;
  chargeMode: RoomChargeMode;
  /** 低消（分，0 为不设） */
  minSpend: number;
  /** 中消（分，0 为不设）：开台时刻在中消时段里、或人数不超过中消人数的按它算 */
  midSpend: number;
  /** 中消时段（一天里的第几分钟，结束不含；结束比开始早的跨零点）；都为空是不按时段 */
  midStart: number | null;
  midEnd: number | null;
  /** 人数不超过这个数用中消；空是不按人数 */
  midMaxGuests: number | null;
  /** 房费（分）：只收房费的房型结账时记一行 */
  roomFee: number;
  sortOrder: number;
  active: boolean;
  /** 挂着这个房型的桌台数（后台列表用） */
  tableCount?: number;
}

/** 这一刻在不在 [start, end) 里（end < start 为跨零点） */
const inMinutes = (minute: number, start: number, end: number) => (start <= end ? minute >= start && minute < end : minute >= start || minute < end);

/** 这一次开台用不用中消：设了中消、而且开台时刻在中消时段里或人数不超过中消人数（两样都没设的不用） */
export function usesMidSpend(t: Pick<DiningRoomType, 'midSpend' | 'midStart' | 'midEnd' | 'midMaxGuests'>, s: { openedMinute: number; guests: number }): boolean {
  if (t.midSpend <= 0) return false;
  const byTime = t.midStart !== null && t.midEnd !== null && inMinutes(s.openedMinute, t.midStart, t.midEnd);
  const byGuests = t.midMaxGuests !== null && s.guests <= t.midMaxGuests;
  return byTime || byGuests;
}

/** 门店的服务费默认：比例（万分之几）与用在哪些桌（rooms 只用在挂了房型的包房，all 所有桌台） */
export interface ServiceFeeDefault {
  serviceFeeBp: number;
  serviceFeeScope: 'rooms' | 'all';
}

export interface TableRuleInput {
  /** 桌台自己设的低消（0 为没设） */
  minSpend: number;
  /** 桌台自己设的服务费比例；空为跟门店默认 */
  serviceFeeBp: number | null;
  roomType: Pick<DiningRoomType, 'name' | 'chargeMode' | 'minSpend' | 'midSpend' | 'midStart' | 'midEnd' | 'midMaxGuests' | 'roomFee'> | null;
}

export interface TableRule {
  /** 这一次开台的低消（分，0 为不设） */
  minSpend: number;
  /** 低消从哪来：桌台自己设的 / 房型低消 / 房型中消 / 没有 */
  minSpendFrom: 'table' | 'room_type' | 'mid' | 'none';
  serviceFeeBp: number;
  /** 服务费从哪来：桌台自己设的 / 门店默认 */
  serviceFeeFrom: 'table' | 'store';
  /** 房费（只收房费的房型；分） */
  roomFee: number;
  roomTypeName: string | null;
}

/**
 * 一次开台按什么收：低消——桌台自己设了的优先，再按房型（只收房费的房型不设低消；中消条件满足的用中消）；
 * 服务费——桌台自己设了（含 0）的优先，没设的跟门店默认（默认只用在包房：挂了房型的桌）
 */
export function tableRuleOf(t: TableRuleInput, store: ServiceFeeDefault, s: { openedMinute: number; guests: number }): TableRule {
  const rt = t.roomType;
  let minSpend = 0;
  let minSpendFrom: TableRule['minSpendFrom'] = 'none';
  if (t.minSpend > 0) {
    minSpend = t.minSpend;
    minSpendFrom = 'table';
  } else if (rt && rt.chargeMode === 'min_spend') {
    if (usesMidSpend(rt, s)) {
      minSpend = rt.midSpend;
      minSpendFrom = 'mid';
    } else if (rt.minSpend > 0) {
      minSpend = rt.minSpend;
      minSpendFrom = 'room_type';
    }
  }
  const storeApplies = store.serviceFeeScope === 'all' || rt !== null;
  const serviceFeeBp = t.serviceFeeBp ?? (storeApplies ? store.serviceFeeBp : 0);
  return {
    minSpend,
    minSpendFrom,
    serviceFeeBp,
    serviceFeeFrom: t.serviceFeeBp === null ? 'store' : 'table',
    roomFee: rt && rt.chargeMode === 'room_fee' ? rt.roomFee : 0,
    roomTypeName: rt?.name ?? null,
  };
}

// ───────────── 公司承担 ─────────────

export const COMPANY_REASONS = ['unwell', 'hosting', 'other'] as const;
export type CompanyReason = (typeof COMPANY_REASONS)[number];
export const COMPANY_REASON_LABELS: Record<CompanyReason, string> = { unwell: '客人身体不适', hosting: '招待', other: '其他' };
/** 公司承担的说明最多 64 个字（选「其他」时必填） */
export const MAX_COMPANY_NOTE = 64;

/** 公司承担的授权对象：一起结账的来访或开台（升序）、金额、原因与说明（与结账时完全一致） */
export interface CompanyChargeScope {
  visitIds: number[];
  tableSessionIds: number[];
  amount: number;
  reason: CompanyReason;
  note: string;
}

/** 「客人身体不适」「其他：试菜」 */
export const companyReasonText = (reason: CompanyReason, note: string) => (note ? `${COMPANY_REASON_LABELS[reason]}：${note}` : COMPANY_REASON_LABELS[reason]);

// ───────────── 返台 ─────────────

/** 已结账的单多久以内还能返台（分钟，默认 30；餐饮规则里改）的上限 */
export const MAX_RETURN_WINDOW_MINUTES = 240;

/** 待清台的桌上一次结了账、补了低消的那次开台（返台用） */
export interface ReturnableSession {
  sessionId: number;
  sessionNo: string;
  checkoutNo: string;
  checkedOutAt: string;
  /** 结账时补的低消（分） */
  topUp: number;
}

// ───────────── 分组默认档口 ─────────────

/** 后台核对列表的一行：菜自己的档口与分组默认档口不一致的菜 */
export interface GroupStationMismatch {
  itemId: number;
  name: string;
  /** 点单分类（restaurant:点心） */
  slot: string;
  slotLabel: string;
  ownStationId: number;
  ownStationName: string;
  groupStationId: number;
  groupStationName: string;
  /** 单独设了档口：照自己的档口出；没单独设的跟分组默认档口出 */
  pinned: boolean;
  /** 设了档口时段的（这些时段里按时段的档口出） */
  hasStationWindows: boolean;
}

export interface GroupStationsAdmin {
  /** 分组 → 默认档口 */
  groupStations: Record<string, number>;
  mismatches: GroupStationMismatch[];
}
