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
 * 控制器能做的事（LOCKER_CAPABILITIES，文档第 6、7 节）：open 远程开柜、doors 查柜门、card 发卡器（读、写、清 M1 手牌）、
 * select 自选柜（手机柜：列出谁占着哪个、远程开一个、释放）。单机电池锁开不了远程，只有前台的发卡器：配 card；
 * 泰格联网锁（店主 2026-11-27）接上以后配 open,doors,card,select。
 */
export const LOCKER_CAPABILITIES = ['open', 'doors', 'card', 'select'] as const;
export type LockerCapability = (typeof LOCKER_CAPABILITIES)[number];

export interface LockerControllerInfo {
  driver: LockerDriverKind;
  /** 能不能远程开柜 */
  canOpen: boolean;
  /** 能不能查柜门开着没有 */
  canDoors: boolean;
  /** 有没有发卡器（读、写、清手牌） */
  canCard: boolean;
  /** 能不能看、开、释放自选柜（手机柜） */
  canSelect: boolean;
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
  /**
   * 结果待确认（Codex 审查 f8b2853）：柜锁桥没回答（超时、断线、5xx），读回核对也没对上——卡可能已经写了、清了，
   * 把卡放回发卡器读卡核对；没写成再写一次（写同一张卡没坏处）。不能当成「没写成」
   */
  uncertain: boolean;
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
  /**
   * 结果待确认（Codex 审查 f8b2853）：柜锁桥没回答（超时、断线、5xx），能查柜门的也没查出来——柜门可能已经开了，
   * 要到柜前确认；不能当成「没开」
   */
  uncertain: boolean;
  /** 控制器的回话（失败时写原因） */
  message: string;
}

/** 远程开柜的原因（必填，记审计）；常用的几句 */
export const LOCKER_OPEN_REASONS = ['客人忘带手牌', '手牌失灵', '清洁、检修', '客人遗留物品'] as const;

/**
 * 写卡、清卡结果待确认时页面记下的那一次（Codex 审查 34a7c87，docs/LOCKERS_V8149.md 第 6.4 节）：
 * 桥没回答、浏览器没收到门店系统的回话（超时、断网、5xx，包括写审计出错）都可能已经写了、清了，
 * 发请求以前记在本机，没有结论就留着，读卡核对出结论才去掉；不能当成没做。
 */
export type LockerCardPending =
  /** 写卡：写之前读到的那张卡的芯片号 + 要写成的柜（Codex 审查 307b2f4：要认准是哪一张卡） */
  | { id: string; op: 'write'; code: string; uid: string; storeId: number; at: string }
  /** 清卡：清之前读到的那张卡的芯片号 */
  | { id: string; op: 'clear'; uid: string; storeId: number; at: string };

/** 读卡核对出「确实做成了」的那一条（只认做成了的证据：读回没变不能断定没做——桥可能还在做，Codex 审查 b446d09） */
export interface LockerCardCheck {
  id: string;
  text: string;
}

/**
 * 读到一张卡以后，哪些待核对的确定做成了（都要是同一张芯片号：别的卡早就写成同一个柜也不算，Codex 审查 307b2f4）：
 *   · 写卡：读到的就是那张卡、卡里写的就是那个柜 → 写成了；
 *   · 清卡：读到的就是那张卡、是空白 → 清成了。
 * 别的都不下结论、记录留着：卡里还是原样，可能原来那次还在桥里没做完（之后会生效），也可能放的不是刚才那张卡；
 * 核对过了（比如已经重写、重清成功，或卡找不到了）由人点「已核对」去掉。
 */
export function settleLockerCardPending(list: readonly LockerPending[], read: Pick<LockerCardRead, 'ok' | 'uid' | 'code'>): LockerCardCheck[] {
  if (!read.ok) return [];
  const out: LockerCardCheck[] = [];
  for (const p of list) {
    if (!p.uid || read.uid !== p.uid) continue;
    if (p.op === 'write') {
      if (read.code === p.code) out.push({ id: p.id, text: `核对：芯片号 ${p.uid} 的卡里是柜 ${p.code}，写成了` });
    } else if (p.op === 'clear' && read.code === null) {
      out.push({ id: p.id, text: `核对：芯片号 ${p.uid} 已清成空白` });
    }
  }
  return out;
}

// ───────────────────────── 自选柜（手机柜，店主 2026-11-27，文档第 7 节） ─────────────────────────

/**
 * 一个自选柜（手机柜）此刻的样子，柜锁桥经锁的网络报上来（POST /select/list）。客人自己挑空柜、刷手牌锁上；
 * 一张手牌只能占一个，别的柜都开不了——这条由锁的网络自己拦（GK2），门店系统负责看得见、标异常、释放。
 */
export interface LockerSelectSlot {
  /** 柜号（如 P012） */
  no: string;
  /** 占着它的手牌的芯片号；空闲为 null */
  uid: string | null;
  /** 柜门开着没有；锁报不了为 null */
  doorOpen: boolean | null;
  /** 从什么时候占着（锁报不了为 null） */
  since: string | null;
}

/** 桥报了芯片号却不像芯片号：记成这个（占着、不认得），释放时不带芯片号 */
export const LOCKER_UID_UNREADABLE = '无法识别';

/**
 * 要人处理的情况：
 *   · multi：同一张手牌占了两个以上（违反一牌一柜：锁的网络没拦住，或者有柜没释放）；
 *   · returned：占着它的手牌已经退了（没有在店的来访单）：要释放，不然下一位拿到这张牌的客人能开；
 *   · unknown：芯片号没绑本店的手牌（外来的卡、还没绑芯片号的牌）。
 */
export const LOCKER_SELECT_ISSUES = ['multi', 'returned', 'unknown'] as const;
export type LockerSelectIssue = (typeof LOCKER_SELECT_ISSUES)[number];
export const LOCKER_SELECT_ISSUE_LABELS: Record<LockerSelectIssue, string> = { multi: '一牌多柜', returned: '已退牌还占着', unknown: '不认得的卡' };

/** 占着自选柜的那张手牌（按 hand_tags.card_uid 找）与它此刻的来访单 */
export interface LockerSelectHolder {
  tagId: number;
  /** 手牌号（就是衣物柜号） */
  code: string;
  /** 在店的来访单；退了牌为 null */
  visitNo: string | null;
}

export interface LockerSelectView extends LockerSelectSlot {
  holder: LockerSelectHolder | null;
  issue: LockerSelectIssue | null;
}

/** 给每个自选柜配上占着它的手牌、标出要处理的情况（顺序照桥报的） */
export function analyzeSelectSlots(slots: readonly LockerSelectSlot[], holders: ReadonlyMap<string, LockerSelectHolder>): LockerSelectView[] {
  const held = new Map<string, number>();
  for (const s of slots) if (s.uid) held.set(s.uid, (held.get(s.uid) ?? 0) + 1);
  return slots.map((s) => {
    if (!s.uid) return { ...s, holder: null, issue: null };
    const holder = holders.get(s.uid) ?? null;
    const issue: LockerSelectIssue | null = (held.get(s.uid) ?? 0) > 1 ? 'multi' : !holder ? 'unknown' : !holder.visitNo ? 'returned' : null;
    return { ...s, holder, issue };
  });
}

/** 远程开自选柜、释放自选柜的结果；uncertain 同发卡器：桥没回答、再列一次也没看出来，不能当成没做 */
export interface LockerSelectResult {
  no: string;
  ok: boolean;
  uncertain: boolean;
  message: string;
}

/** 释放手机柜结果待确认时页面记下的那一次（同 LockerCardPending：发请求以前记在本机，列表核对出结论才去掉） */
export interface LockerSelectPending {
  id: string;
  op: 'release';
  no: string;
  /** 释放的是哪张手牌占着的；页面没看到芯片号为 null */
  uid: string | null;
  storeId: number;
  at: string;
}

/** 本机记着的待核对的柜锁操作：发卡器写卡、清卡与释放手机柜 */
export type LockerPending = LockerCardPending | LockerSelectPending;

/**
 * 列出手机柜以后，哪些「释放」确定做成了（只看在这次释放之后才发出的查询：askedAt 晚于记下的时间，两个都是本机的钟）：
 * 柜子空了、换成别的手牌占着 → 释放了。还是那张手牌占着的不下结论、记录留着（原来那次可能还在桥里没做完，同 settleLockerCardPending）；
 * 没记芯片号、柜子又被占着的也不下结论。
 */
export function settleLockerSelectPending(list: readonly LockerPending[], slots: readonly LockerSelectSlot[], askedAt: string): LockerCardCheck[] {
  const out: LockerCardCheck[] = [];
  for (const p of list) {
    if (p.op !== 'release' || Date.parse(askedAt) <= Date.parse(p.at)) continue;
    const slot = slots.find((x) => x.no === p.no);
    if (!slot) continue;
    if (slot.uid === null || (p.uid && slot.uid !== p.uid)) out.push({ id: p.id, text: `核对：手机柜 ${p.no} 已经释放了` });
  }
  return out;
}

/** 远程开、释放自选柜的原因（必填，记审计）；常用的几句 */
export const LOCKER_SELECT_REASONS = ['客人忘带手牌', '客人已退牌', '手牌失灵', '一牌多柜', '清洁、检修'] as const;
