// 前台备注（8.1.44《前台系统开发》第 1、8 条，docs/V8144_CASHIER.md）：记经办人与时间，分同组备注与单人备注，可带一个标签。
// 发卡台客人卡与收银台「备注」板块是同一份数据。标签清单在「数据字典」的 remarkTags（默认见 custom-fields，待业务确认）。

export const REMARK_SCOPES = ['single', 'group'] as const;
export type RemarkScope = (typeof REMARK_SCOPES)[number];
export const REMARK_SCOPE_LABELS: Record<RemarkScope, string> = { single: '单人备注', group: '同组备注' };

/** 备注正文最多几个字；标签最多几个字（与数据字典每一项的上限一致） */
export const MAX_REMARK_LENGTH = 200;
export const MAX_REMARK_TAG_LENGTH = 20;

export interface VisitRemark {
  id: number;
  scope: RemarkScope;
  /** 写在哪位客人上（同组备注是写的时候打开的那位）：手牌号与来访编号 */
  visitId: number;
  tagCode: string;
  /** 同组备注的同行组号；单人备注为 null */
  groupNo: string | null;
  tag: string;
  note: string;
  createdById: number;
  createdByName: string;
  createdAt: string;
  /** 撤下了：谁、几点、原因；没撤为 null */
  removed: { byName: string; at: string; reason: string } | null;
}
