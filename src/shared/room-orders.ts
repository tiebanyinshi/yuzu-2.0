// 8.2.0 P07 / P08（回测 3-1，docs/YUZU_REQ_V820.md 第 8、9 节）：房态中心「在用」的房间直接点水吧、果吧。
//   · 下单就是挂到这间房现在那位客人的手牌账单上（与点单页同一个挂账），同时出出品单（送到哪：「房 V08」），出品屏、自动打印照旧；
//   · 每一单另记是从哪间房点的（room_orders），卡片上写这次在用点了几单、多少钱，房间里点过什么能逐笔看、逐行退；
//   · 门店按出品口配置房态点单能点哪几个分类（康美部在房间里点的就是这几类）。

import type { DiningOutlet } from './dining';
import type { Permission } from './permissions';

/** 房态点单能点的出品口：水吧、果吧 */
export const ROOM_ORDER_OUTLETS = ['water', 'fruit'] as const satisfies readonly DiningOutlet[];
export type RoomOrderOutlet = (typeof ROOM_ORDER_OUTLETS)[number];
export const ROOM_ORDER_OUTLET_LABELS: Record<RoomOrderOutlet, string> = { water: '水吧', fruit: '果吧' };
/** 在哪个出品口下单要哪一项权限（与点单页相同）；处理这个出品口的待确认点单也要它 */
export const ROOM_ORDER_PERMISSIONS: Record<RoomOrderOutlet, Permission> = { water: 'dining.orderWater', fruit: 'dining.orderFruit' };

export const isRoomOrderOutlet = (v: unknown): v is RoomOrderOutlet => typeof v === 'string' && (ROOM_ORDER_OUTLETS as readonly string[]).includes(v);

/** 一道菜在房态点单里归哪个分类：有点单小分类的（水吧：手作饮料、糖水、调酒）按小分类，没有的（果吧）按价目分类 */
export const roomOrderCategoryOf = (d: { group: string; category: string }): string => d.group || d.category.trim() || '其他';

/** 一次最多点几行；每行最多几份；分类名单最多几个 */
export const MAX_ROOM_ORDER_LINES = 30;
export const MAX_ROOM_ORDER_QUANTITY = 99;
export const MAX_ROOM_ORDER_CATEGORIES = 50;
/** 房间的点单记录一次最多列几单 */
export const ROOM_ORDER_HISTORY_LIMIT = 100;

/** 房态中心的一间房：s<空间编号> 或 r<客房房间编号>（与卡片的 key 一样） */
export const parseRoomKey = (key: string): { spaceId: number } | { roomId: number } | null => {
  const m = /^([sr])([1-9]\d{0,17})$/.exec(key);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id)) return null;
  return m[1] === 's' ? { spaceId: id } : { roomId: id };
};

/** 门店的配置：每个出品口能点哪几个分类（null 为全部） */
export interface RoomOrderConfig {
  outlets: Record<RoomOrderOutlet, { categories: string[] | null }>;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 后台配置页：每个出品口现有的分类（菜单里有菜的），好勾选 */
export interface RoomOrderConfigAdmin extends RoomOrderConfig {
  available: Record<RoomOrderOutlet, string[]>;
}

/** 卡片上的：这次在用（房里现在的客人）点了几单、多少钱（退掉的不算） */
export interface RoomOrderSummary {
  count: number;
  amount: number;
}

export interface RoomOrderLineView {
  lineId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  /** 口味备注（做法、加料也写在这里），印在出品单上 */
  note: string;
  status: 'posted' | 'voided';
  voidReason: string | null;
  voidedByName: string | null;
  voidedAt: string | null;
}

export interface RoomOrderView {
  id: number;
  roomCode: string;
  outlet: RoomOrderOutlet;
  /** 出品单号 */
  orderNo: string | null;
  tagCode: string;
  /** 这位客人还在店（手牌没结账）：在店的才能退 */
  visitOpen: boolean;
  /** 整单备注（印在这一单每道菜的出品单上） */
  note: string;
  /** 下单时的合计；现在的合计（退掉的不算） */
  postedTotal: number;
  total: number;
  /** 经办人：工号（登录账号）与姓名 */
  staffUsername: string;
  staffName: string;
  createdAt: string;
  lines: RoomOrderLineView[];
}

export interface RoomOrderHistory {
  roomKey: string;
  roomCode: string;
  /** 现在房里的客人点的（卡片上那两个数） */
  current: RoomOrderSummary;
  orders: RoomOrderView[];
  limit: number;
  truncated: boolean;
}

/** 下单的回复：这一单（同一编号重提返回第一次的，replayed 为真） */
export interface RoomOrderResult {
  order: RoomOrderView;
  replayed: boolean;
}
