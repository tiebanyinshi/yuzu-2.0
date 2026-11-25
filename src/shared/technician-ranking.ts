// 技师榜单（docs/TECH_RANKING.md，店主 2026-11-24《技师榜单模块需求说明》）：技师管理里的页签，按工种看技师照片卡片与实时状态。
// 状态由服务端按钟房算好（TR2），页面只显示；服务中的剩余时间由页面按服务器时间每秒倒计时。服务端与页面共用。

/** 榜单上的三种状态 */
export const RANKING_STATUSES = ['idle', 'serving', 'off'] as const;
export type RankingStatus = (typeof RANKING_STATUSES)[number];
export const RANKING_STATUS_LABELS: Record<RankingStatus, string> = { idle: '空闲', serving: '服务中', off: '未当班' };

/** 状态下面的小字（钟房里的细分）：休息 / 待上钟 / 休假 / 停牌；没有为 null */
export type RankingNote = 'rest' | 'waiting' | 'leave' | 'suspended' | null;
export const RANKING_NOTE_LABELS: Record<Exclude<RankingNote, null>, string> = { rest: '暂离', waiting: '待上钟', leave: '休假', suspended: '停牌' };

/** 综合榜 / 人气榜 */
export const RANKING_BOARDS = ['overall', 'popular'] as const;
export type RankingBoard = (typeof RANKING_BOARDS)[number];
export const RANKING_BOARD_LABELS: Record<RankingBoard, string> = { overall: '综合榜', popular: '人气榜' };

/** 每页 12 张（TR7；刷新间隔在技师规则里，默认 30 秒）；人气值按近 30 天（TR3） */
export const RANKING_PAGE_SIZE = 12;
export const RANKING_POPULARITY_DAYS = 30;

/** 服务中的那一张钟单（不带客人、手牌、房间，TR6） */
export interface RankingService {
  sessionId: number;
  itemName: string;
  /** waiting 已派待上（没有开始时间，不倒计时）/ serving 在钟上 */
  phase: 'waiting' | 'serving';
  /** 上钟时刻；待上钟为 null */
  startedAt: string | null;
  /** 钟单时长（分钟，含加钟） */
  minutes: number;
  /** 计划下钟 = 上钟时刻 + 时长；待上钟为 null */
  plannedEnd: string | null;
  /** 按服务器时间算的已服务秒数、剩余秒数（到点没下钟的剩余为 0）；待上钟为 null */
  elapsedSeconds: number | null;
  remainingSeconds: number | null;
}

export interface RankingTech {
  id: number;
  techNo: string;
  /** 有花名的显示花名 */
  name: string;
  /** 名册上的姓名（搜索用；有花名时与 name 不同） */
  realName: string;
  /** 工种（名册的类型）；没设为空 */
  kind: string;
  /** 照片地址；没照片为 null（显示占位头像） */
  photoUrl: string | null;
  status: RankingStatus;
  note: RankingNote;
  /** 人气值：近 30 天的点钟钟数（TR3） */
  popularity: number;
  /** 综合榜的名次（1 起）：钟房的排位顺序（在岗的按排位，其余按技师号） */
  overallRank: number;
  service: RankingService | null;
}

export interface TechnicianRankingView {
  serverTime: string;
  businessDate: string;
  /** 多久取一次（秒）、每页几张 */
  refreshSeconds: number;
  pageSize: number;
  popularityDays: number;
  /** 工种标签：名册的工种字典（技师管理里维护），再加上名册里用着、字典里已经没有的 */
  kinds: string[];
  /** 按综合榜排好 */
  techs: RankingTech[];
  counts: Record<RankingStatus, number>;
}

export const technicianPhotoUrl = (id: number | null) => (id === null ? null : `/api/technician-photos/${id}`);

/** 搜索：技师号（可带「No.」）、姓名、花名模糊匹配，不分大小写 */
export function matchesRankingText(t: Pick<RankingTech, 'techNo' | 'name' | 'realName'>, text: string): boolean {
  const q = text
    .trim()
    .toLowerCase()
    .replace(/^no\.?\s*/, '');
  if (!q) return true;
  return t.techNo.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.realName.toLowerCase().includes(q);
}

/** 页面上的筛选：工种（null = 全部）、状态（all = 全部）、搜索词，三样叠加 */
export function filterRanking(techs: readonly RankingTech[], f: { kind: string | null; status: RankingStatus | 'all'; text: string }): RankingTech[] {
  return techs.filter((t) => (f.kind === null || t.kind === f.kind) && (f.status === 'all' || t.status === f.status) && matchesRankingText(t, f.text));
}

/** 第几页（1 起）的那几张；页码超出时落到最后一页 */
export function pageOf<T>(list: readonly T[], page: number, size: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const p = Math.min(Math.max(1, page), pages);
  return { items: list.slice((p - 1) * size, p * size), page: p, pages };
}

/**
 * 榜单排序：综合榜照服务端给的顺序（钟房排位）；人气榜按人气值从高到低，同分按综合榜先后（TR3）。
 * 名次在工种筛选之后、状态与搜索之前算（换工种看的是这个工种里的名次，筛状态、搜人不改名次）
 */
export function rankOf(techs: readonly RankingTech[], board: RankingBoard): { tech: RankingTech; rank: number }[] {
  const sorted = board === 'popular' ? [...techs].sort((a, b) => b.popularity - a.popularity || a.overallRank - b.overallRank) : [...techs];
  return sorted.map((tech, i) => ({ tech, rank: i + 1 }));
}

/** 前三名的标识（人气榜、人气值大于 0 的才给）：皇冠 / 银牌 / 铜牌 */
export const podiumOf = (rank: number, popularity: number, board: RankingBoard): 1 | 2 | 3 | null => (board === 'popular' && popularity > 0 && rank <= 3 ? (rank as 1 | 2 | 3) : null);

/** 服务进度（0–1）与剩余秒数：按页面上的「服务器时间」算；待上钟的没有 */
export function serviceProgress(s: RankingService, serverNow: number): { elapsed: number; remaining: number; ratio: number } | null {
  if (!s.startedAt || !s.plannedEnd) return null;
  const start = new Date(s.startedAt).getTime();
  const end = new Date(s.plannedEnd).getTime();
  const elapsed = Math.max(0, Math.floor((serverNow - start) / 1000));
  const remaining = Math.max(0, Math.ceil((end - serverNow) / 1000));
  return { elapsed, remaining, ratio: end > start ? Math.min(1, Math.max(0, (serverNow - start) / (end - start))) : 1 };
}

/** 剩余时间：1:05:09 / 12:03 */
export function countdownText(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
}
