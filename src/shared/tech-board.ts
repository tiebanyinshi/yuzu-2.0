// 回测整改 P09（回测 4-2，docs/YUZU_REQ_V820.md 第 10 节）：技师上钟轮播（大屏，只读）。
//   · 最左一列固定：排钟顺序（序号、技师号与花名、现在的状态），不跟着轮播；
//   · 右边一列一个「指标」：按项目看是一个项目一列，按区域看是一个区域一列；列里的卡片写房间、开始时间、已上钟、预计下钟，列头写下一位排钟；
//   · 列多了一屏放不下就自动翻页轮播（间隔 5–15 秒可调），能暂停、继续、手动左右翻，鼠标停在上面暂停；
//   · 数据与钟房同一份（clockroomBoard），几秒取一次；只读，没有任何改钟的入口。

import type { TechFilter } from './clockroom';

export const TECH_BOARD_MODES = ['item', 'area'] as const;
export type TechBoardMode = (typeof TECH_BOARD_MODES)[number];
export const TECH_BOARD_MODE_LABELS: Record<TechBoardMode, string> = { item: '按项目', area: '按区域' };

/** 轮播间隔（秒）：可选的几档，默认 8 秒 */
export const TECH_BOARD_INTERVALS = [5, 8, 10, 15] as const;
export const TECH_BOARD_DEFAULT_INTERVAL = 8;
/** 大屏多久取一次数 */
export const TECH_BOARD_REFRESH_MS = 5_000;

/** 大屏上列的技师状态（不列休假、未上牌的） */
export type TechBoardStatus = Exclude<TechFilter, 'all' | 'leave' | 'off'>;
export const TECH_BOARD_STATUSES: readonly TechBoardStatus[] = ['serving', 'waiting', 'idle', 'rest', 'suspended'];

/** 没选房间的钟归到哪个区域 */
export const NO_AREA = '未选房间';

export interface TechBoardTech {
  id: number;
  techNo: string;
  /** 有花名的写花名 */
  name: string;
  kind: string;
  status: TechBoardStatus;
  /** 在轮钟队列里的位置（1 起）；不在队列里（休息、停牌）为 null */
  position: number | null;
}

export interface TechBoardSession {
  id: number;
  technicianId: number;
  itemName: string;
  status: 'waiting' | 'serving';
  /** 房间号；没选房间为 null */
  room: string | null;
  /** 房间所在的区域（空间台账的区域，没有区域的写楼层）；没选房间为 null */
  area: string | null;
  startedAt: string | null;
  plannedEnd: string | null;
  minutes: number;
  clocks: number;
}

export interface TechBoardView {
  serverTime: string;
  businessDate: string;
  /** 排钟顺序：队列里的按位置在前，其余（休息、停牌）按技师号在后 */
  techs: TechBoardTech[];
  sessions: TechBoardSession[];
  /** 下一位排钟：队列里最靠前的空闲技师；没有为 null */
  next: { techNo: string; name: string } | null;
  /** 筛选用：技师类型、项目、区域的清单 */
  kinds: string[];
  items: string[];
  areas: string[];
}
