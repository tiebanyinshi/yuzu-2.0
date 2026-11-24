// 技师榜单（docs/TECH_RANKING.md，店主 2026-11-24《技师榜单模块需求说明》）：技师管理里的页签，按工种看技师照片卡片与实时状态。
// 状态由服务端按钟房算好（TR2），页面只显示；服务中的剩余时间由页面按服务器时间每秒倒计时。服务端与页面共用。

/** 榜单上的三种状态 */
export const RANKING_STATUSES = ['idle', 'serving', 'off'] as const;
export type RankingStatus = (typeof RANKING_STATUSES)[number];

/** 状态下面的小字（钟房里的细分）：休息 / 待上钟 / 休假 / 停牌；没有为 null */
export type RankingNote = 'rest' | 'waiting' | 'leave' | 'suspended' | null;

/** 默认：30 秒取一次、每页 12 张（TR7）；人气值按近 30 天（TR3） */
export const RANKING_DEFAULT_REFRESH_SECONDS = 30;
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
