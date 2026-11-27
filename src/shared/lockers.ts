// 柜况（8.1.49，docs/LOCKERS_V8149.md）：前台、值班经理看全店手牌柜此刻的状态（空闲 / 在用 / 锁定 / 暂停 / 维修 / 停用），按区分组计数；
// 另预留智能柜锁的接口（采购清单里还没有柜锁控制器，PENDING_DECISIONS D8）：控制器到货前接「没配」，开发、测试接模拟的。
// 手牌 = 柜子的钥匙（一牌一柜，柜号就是牌号，附录 A 的 747 个），所以柜况直接读手牌板，不另建柜子表。

import { tagArea, TAG_KIND_LABELS, ZONE_LABELS, type BoardTag, type TagKind, type TagZone } from './frontdesk';

/** 一个柜子此刻的状态：按这个顺序判断（在用优先——锁定、维修中的柜子里也可能还有客人） */
export const LOCKER_STATES = ['in_use', 'locked', 'repair', 'paused', 'inactive', 'free'] as const;
export type LockerState = (typeof LOCKER_STATES)[number];
export const LOCKER_STATE_LABELS: Record<LockerState, string> = {
  in_use: '在用',
  locked: '锁定',
  repair: '维修中',
  paused: '暂停使用',
  inactive: '停用',
  free: '空闲',
};

export function lockerState(t: Pick<BoardTag, 'visit' | 'locked' | 'serviceStatus' | 'active'>): LockerState {
  if (t.visit) return 'in_use';
  if (t.locked) return 'locked';
  if (!t.active) return 'inactive';
  if (t.serviceStatus === 'repair') return 'repair';
  if (t.serviceStatus === 'paused') return 'paused';
  return 'free';
}

export interface LockerGroup {
  /** 分组键：男宾普通 A 区 = male:normal:A；VIP 按等级 = male:vip:3 */
  key: string;
  zone: TagZone;
  kind: TagKind;
  title: string;
  tags: BoardTag[];
  counts: Record<LockerState, number>;
}

const emptyCounts = (): Record<LockerState, number> => ({ in_use: 0, locked: 0, repair: 0, paused: 0, inactive: 0, free: 0 });

/** 按「男宾 / 女宾 × 普通柜按区 / VIP 柜按等级」分组；板上的顺序已经排好，组按第一次出现的顺序 */
export function groupLockers(tags: readonly BoardTag[]): { groups: LockerGroup[]; total: Record<LockerState, number> } {
  const groups = new Map<string, LockerGroup>();
  const total = emptyCounts();
  for (const t of tags) {
    const area = t.kind === 'vip' ? String(t.vipLevel ?? 0) : tagArea(t.code) || '—';
    const key = `${t.zone}:${t.kind}:${area}`;
    let g = groups.get(key);
    if (!g) {
      const zone = ZONE_LABELS[t.zone].title;
      const title = t.kind === 'vip' ? `${zone} VIP 第 ${t.vipLevel} 级` : `${zone}${TAG_KIND_LABELS.normal} ${area} 区`;
      g = { key, zone: t.zone, kind: t.kind, title, tags: [], counts: emptyCounts() };
      groups.set(key, g);
    }
    const s = lockerState(t);
    g.tags.push(t);
    g.counts[s] += 1;
    total[s] += 1;
  }
  return { groups: [...groups.values()], total };
}

// ───────────────────────── 智能柜锁（预留接口） ─────────────────────────

/** 接哪种控制器：none 没配（默认，开柜按钮不显示）；mock 模拟（开发、测试）；http 本机的柜锁桥（厂家协议由桥翻译，见文档第 3 节） */
export const LOCKER_DRIVERS = ['none', 'mock', 'http'] as const;
export type LockerDriverKind = (typeof LOCKER_DRIVERS)[number];

/** 控制器报上来的一个柜门的状态；控制器不支持查询时 doorOpen 为 null */
export interface LockerDoor {
  code: string;
  doorOpen: boolean | null;
  /** 控制器认不认得这个柜号（没接线、编号表里没有） */
  known: boolean;
}

/**
 * 控制器能做的事（LOCKER_CAPABILITIES，文档第 6 节）：open 远程开柜、doors 查柜门、card 发卡器（读、写、清 M1 手牌）。
 * 泰格这类单机电池锁开不了远程，只有前台的发卡器：配 card。
 */
export const LOCKER_CAPABILITIES = ['open', 'doors', 'card'] as const;
export type LockerCapability = (typeof LOCKER_CAPABILITIES)[number];

export interface LockerControllerInfo {
  driver: LockerDriverKind;
  /** 能不能远程开柜 */
  canOpen: boolean;
  /** 能不能查柜门开着没有 */
  canDoors: boolean;
  /** 有没有发卡器（读、写、清手牌） */
  canCard: boolean;
}

/** 一张手牌能开的一把锁：衣物柜、手机柜、其他（鞋柜等）。手牌号 → 哪几把锁由柜锁桥的对照表定 */
export const LOCKER_LOCK_KINDS = ['clothes', 'phone', 'other'] as const;
export type LockerLockKind = (typeof LOCKER_LOCK_KINDS)[number];
export const LOCKER_LOCK_KIND_LABELS: Record<LockerLockKind, string> = { clothes: '衣物柜', phone: '手机柜', other: '其他' };

export interface LockerCardLock {
  kind: LockerLockKind;
  no: string;
}

/** 发卡器读到的卡 */
export interface LockerCardRead {
  /** 读到了没有（没放卡、读不出来为 false，原因在 message） */
  ok: boolean;
  /** M1 芯片号（去掉分隔符、转大写，与手牌绑的芯片号同一种写法） */
  uid: string | null;
  /** 卡里写的手牌号（空白卡为 null） */
  code: string | null;
  locks: LockerCardLock[];
  message: string;
}

/** 写卡、清卡的结果 */
export interface LockerCardResult {
  ok: boolean;
  uid: string | null;
  message: string;
}

/** 读卡的回答：卡上的内容 + 这个芯片号绑的是哪张手牌（按 hand_tags.card_uid） */
export interface LockerCardReadView extends LockerCardRead {
  tag: { id: number; code: string } | null;
  /** 卡里写的柜号与芯片号绑的手牌对不上 */
  mismatch: boolean;
}

/** 写卡、清卡的原因（必填，记审计）；常用的几句 */
export const LOCKER_CARD_REASONS = ['补发手牌', '手牌失灵重写', '新手牌初始化', '退牌回收', '作废'] as const;

export interface LockerOpenResult {
  code: string;
  opened: boolean;
  /** 控制器的回话（失败时写原因） */
  message: string;
}

/** 远程开柜的原因（必填，记审计）；常用的几句 */
export const LOCKER_OPEN_REASONS = ['客人忘带手牌', '手牌失灵', '清洁、检修', '客人遗留物品'] as const;
