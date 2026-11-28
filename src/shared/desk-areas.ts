// 8.2.27 发卡台区域状态（docs/V82227_DESK_UI.md；店主 2026-11-27 收银员工作台 demo 的「区域卡片 + 推荐」）：
//   按分区（男宾 / 女宾）里的区（牌号的字母前缀：A 区、B 区；没有字母的是「普通柜」）算：
//   · 空闲：最近 15 分钟没往这个区发过牌；繁忙：最近 15 分钟发了 3 张以上；已满：没有能发的空牌；其余正常；
//   · 推荐顺序：空闲 > 正常 > 繁忙 > 已满，同一档先看在店占比低的，再看停得久的（上一次发牌早的）；每个分区排第一的标「推荐」。
// VIP 柜不参与（按客人指定发）。

import { tagArea, tagIssuable, type HandTag, type TagZone } from './frontdesk';

export const AREA_BUSY_WINDOW_MINUTES = 15;
export const AREA_BUSY_ISSUES = 3;

export type AreaState = 'idle' | 'normal' | 'busy' | 'full';
export const AREA_STATE_LABELS: Record<AreaState, string> = { idle: '空闲', normal: '正常', busy: '繁忙', full: '已满' };
const RANK: Record<AreaState, number> = { idle: 0, normal: 1, busy: 2, full: 3 };

export interface AreaTag {
  code: string;
  zone: TagZone;
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  serviceStatus: HandTag['serviceStatus'];
  visit: { checkedInAt: string } | null;
}

export interface AreaStatus {
  zone: TagZone;
  /** 区名（字母前缀）；空串是没有字母的普通柜 */
  area: string;
  total: number;
  inStore: number;
  free: number;
  /** 最近 15 分钟发了几张 */
  recent: number;
  /** 最近一次发牌的时刻；没人在店为 null */
  lastIssuedAt: string | null;
  state: AreaState;
  /** 这个分区里排第一（推荐往这里发） */
  recommended: boolean;
}

/** 各区的状态，按分区、推荐顺序排好 */
export function areaStatuses(tags: readonly AreaTag[], now: number): AreaStatus[] {
  const since = now - AREA_BUSY_WINDOW_MINUTES * 60_000;
  const map = new Map<string, AreaStatus>();
  for (const t of tags) {
    if (t.kind !== 'normal' || !t.active) continue;
    const area = tagArea(t.code);
    const key = `${t.zone}|${area}`;
    const s = map.get(key) ?? { zone: t.zone, area, total: 0, inStore: 0, free: 0, recent: 0, lastIssuedAt: null, state: 'normal' as AreaState, recommended: false };
    s.total += 1;
    if (t.visit) {
      s.inStore += 1;
      const at = Date.parse(t.visit.checkedInAt);
      if (at >= since) s.recent += 1;
      if (!s.lastIssuedAt || at > Date.parse(s.lastIssuedAt)) s.lastIssuedAt = t.visit.checkedInAt;
    } else if (tagIssuable(t)) s.free += 1;
    map.set(key, s);
  }
  const list = [...map.values()].map((s) => ({ ...s, state: (s.free === 0 ? 'full' : s.recent >= AREA_BUSY_ISSUES ? 'busy' : s.recent === 0 ? 'idle' : 'normal') as AreaState }));
  const occ = (s: AreaStatus) => (s.total ? s.inStore / s.total : 1);
  const last = (s: AreaStatus) => (s.lastIssuedAt ? Date.parse(s.lastIssuedAt) : 0);
  list.sort((a, b) => a.zone.localeCompare(b.zone) || RANK[a.state] - RANK[b.state] || occ(a) - occ(b) || last(a) - last(b) || a.area.localeCompare(b.area));
  const seen = new Set<TagZone>();
  for (const s of list) {
    if (!seen.has(s.zone) && s.state !== 'full') {
      s.recommended = true;
      seen.add(s.zone);
    }
  }
  return list;
}

/** 区的叫法：A 区 / 普通柜 */
export const areaLabel = (area: string) => (area ? `${area} 区` : '普通柜');

/**
 * 8.2.27 按人数发牌：这个分区要 count 张，按推荐顺序（areaStatuses）逐区挑能发的空牌（区里按牌号顺序），一个区不够接着下一个区。
 * except：已经分给本次别的客人、或店员手动填了的牌。返回挑到的牌号（可能少于 count：空牌不够）
 */
export function pickAreaTags(tags: readonly (AreaTag & { code: string })[], zone: TagZone, count: number, now: number, except: ReadonlySet<string> = new Set()): string[] {
  if (count <= 0) return [];
  const order = areaStatuses(tags, now)
    .filter((a) => a.zone === zone && a.state !== 'full')
    .map((a) => a.area);
  const out: string[] = [];
  for (const area of order) {
    const free = tags
      .filter((t) => t.zone === zone && t.kind === 'normal' && tagArea(t.code) === area && tagIssuable(t) && !except.has(t.code) && !out.includes(t.code))
      .map((t) => t.code)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    for (const code of free) {
      if (out.length >= count) return out;
      out.push(code);
    }
  }
  return out;
}
