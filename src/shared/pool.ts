// 8.2.27 男汤 / 女汤泡池（docs/V82227_POOL.md）：前后端共用。

/** 泡池区刷到的客人（在店的） */
export interface PoolGuest {
  visitId: number;
  tagCode: string;
  /** 客人的区（男宾 / 女宾）；与选的男汤 / 女汤不一致时页面提醒 */
  zone: string;
  ticketName: string | null;
}

/** 泡池区刷到的技师 */
export interface PoolTechnician {
  id: number;
  techNo: string;
  name: string;
  nickname: string;
}

/** 男汤 / 女汤 */
export const POOL_SIDES = ['male', 'female'] as const;
export type PoolSide = (typeof POOL_SIDES)[number];
export const POOL_SIDE_LABELS: Record<PoolSide, string> = { male: '男汤', female: '女汤' };
