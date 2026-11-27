// 「工作台」的入口（docs/STAFF_MP.md 第 2.4 节）：按要办的事分组。服务端在「我是谁」里给出这个人能用的入口（entries），
// 这里只管每个入口叫什么、什么图标、去哪一页、搜什么词能搜到。page 为空的入口还没做到小程序里（不显示）。

import type { StaffMpEntryKey } from '../../../src/shared/staffmp';

export interface EntryDef {
  key: StaffMpEntryKey;
  label: string;
  /** 图标名（src/assets/icons/<名字>.png，scripts/render-icons.mjs 生成） */
  icon: string;
  group: EntryGroup;
  /** 去哪一页；还没做到小程序里的为空 */
  page: string | null;
  /** 搜索时还认哪些词 */
  keywords: string[];
}

export type EntryGroup = 'attendance' | 'approval' | 'meal' | 'patrol' | 'people' | 'learn';

export const GROUP_LABELS: Record<EntryGroup, string> = {
  attendance: '考勤',
  approval: '申请与审批',
  meal: '吃饭',
  patrol: '巡场',
  people: '人事',
  learn: '学习',
};

export const GROUP_ORDER: EntryGroup[] = ['attendance', 'approval', 'meal', 'patrol', 'people', 'learn'];

export const ENTRIES: EntryDef[] = [
  { key: 'punch', label: '打卡', icon: 'punch', group: 'attendance', page: null, keywords: ['上班', '下班', '考勤', '外勤'] },
  { key: 'schedule', label: '我的排班', icon: 'schedule', group: 'attendance', page: null, keywords: ['班次', '排班', '上班时间'] },
  { key: 'attendance', label: '考勤记录', icon: 'attendance', group: 'attendance', page: null, keywords: ['迟到', '早退', '缺卡', '补卡'] },
  { key: 'leave', label: '假期余额', icon: 'leave', group: 'attendance', page: null, keywords: ['请假', '年假', '调休', '假'] },
  { key: 'approvals', label: '申请与审批', icon: 'approvals', group: 'approval', page: null, keywords: ['请假', '补卡', '审批', '申请', '异议'] },
  { key: 'canteen', label: '饭卡码', icon: 'canteen', group: 'meal', page: null, keywords: ['吃饭', '食堂', '菜单', '饭堂'] },
  { key: 'canteenScan', label: '扫码登记', icon: 'scan', group: 'meal', page: null, keywords: ['食堂', '扫码', '负责人'] },
  { key: 'patrol', label: '扫码巡场', icon: 'patrol', group: 'patrol', page: null, keywords: ['巡场', '安保', '巡逻'] },
  { key: 'patrolLog', label: '巡场记录', icon: 'patrolLog', group: 'patrol', page: null, keywords: ['巡场', '记录', '漏巡'] },
  { key: 'payslips', label: '工资条', icon: 'payslips', group: 'people', page: null, keywords: ['工资', '薪资', '签收'] },
  { key: 'directory', label: '通讯录', icon: 'directory', group: 'people', page: null, keywords: ['电话', '同事', '联系'] },
  { key: 'announcements', label: '公告', icon: 'announcements', group: 'people', page: null, keywords: ['通知', '公司公告'] },
  { key: 'knowledge', label: '知识库', icon: 'knowledge', group: 'learn', page: '/pages/learn/index', keywords: ['培训', '资料', '应知应会', '学习'] },
  { key: 'academy', label: '汤崎学堂', icon: 'academy', group: 'learn', page: null, keywords: ['学习', '课程', '必修', '考试'] },
];

export interface EntryView {
  key: StaffMpEntryKey;
  label: string;
  icon: string;
  page: string;
}

export interface GroupView {
  group: EntryGroup;
  label: string;
  entries: EntryView[];
}

/** 这个人能用的、已经做到小程序里的入口，按组排好；keyword 不为空时只留叫这个名字、或认这个词的（纯函数，单元测试核对） */
export function entryGroups(allowed: readonly StaffMpEntryKey[], keyword = ''): GroupView[] {
  const k = keyword.trim();
  const has = new Set(allowed);
  const usable = ENTRIES.filter((e) => has.has(e.key) && e.page !== null).filter((e) => !k || e.label.includes(k) || e.keywords.some((w) => w.includes(k) || k.includes(w)));
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    entries: usable.filter((e) => e.group === group).map((e) => ({ key: e.key, label: e.label, icon: e.icon, page: e.page! })),
  })).filter((g) => g.entries.length > 0);
}
