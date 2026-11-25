// WCP（员工工作台，原「办公」）的入口清单：首页的方块与 WCP 外壳的侧栏用同一份（店主 2026-11-24，docs/BOARDS.md）。

import {
  Bell,
  BookOpen,
  BookUser,
  CalendarCheck,
  CalendarDays,
  Fingerprint,
  GraduationCap,
  MessagesSquare,
  Palmtree,
  ReceiptText,
  ScanFace,
  SlidersHorizontal,
  Stamp,
  UserRound,
  LayoutGrid,
  type LucideIcon,
} from 'lucide-react';
import { ADMIN_SECTIONS, visibleBoardSections } from '@shared/admin';
import { useCan, useSession } from '../../lib/session';

export interface WcpNavItem {
  to: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  testId: string;
}

export const WCP_TILES: readonly WcpNavItem[] = [
  { to: '/oa/im', label: '消息', hint: '同事单聊、群聊，发图片与文件', icon: MessagesSquare, testId: 'oa-tile-im' },
  { to: '/oa/directory', label: '通讯录', hint: '按部门找同事、看资料、发消息', icon: BookUser, testId: 'oa-tile-directory' },
  { to: '/oa/approvals', label: '审批', hint: '请假、加班、出差、报销、补卡', icon: Stamp, testId: 'oa-tile-approvals' },
  { to: '/oa/punch', label: '打卡', hint: '按排班打上下班卡、外勤打卡', icon: Fingerprint, testId: 'oa-tile-punch' },
  { to: '/oa/schedule', label: '我的排班', hint: '这个月每天上什么班', icon: CalendarDays, testId: 'oa-tile-schedule' },
  { to: '/oa/attendance', label: '我的考勤', hint: '每天的考勤结果、迟到缺卡', icon: CalendarCheck, testId: 'oa-tile-attendance' },
  { to: '/oa/leave', label: '假期余额', hint: '年假等还剩几天、发放与扣减明细', icon: Palmtree, testId: 'oa-tile-leave' },
  { to: '/oa/payslips', label: '工资条', hint: '按月看本人的工资条、确认签收', icon: ReceiptText, testId: 'oa-tile-payslips' },
  { to: '/oa/face', label: '人脸录入', hint: '打卡要人脸的先录入、等审核', icon: ScanFace, testId: 'oa-tile-face' },
  // 员工培训（店主 2026-11-25，docs/TRAINING.md）：培训资料与本部门的培训文件；管理在「WCP 设置 → 员工培训」
  { to: '/oa/training', label: '员工培训', hint: '培训资料与本部门的培训文件', icon: GraduationCap, testId: 'oa-tile-training' },
  { to: '/oa/notifications', label: '通知', hint: '排班变更、审批、工资条等提醒', icon: Bell, testId: 'oa-tile-notifications' },
];

/** 这位账号的 WCP 入口：人人都有的十一项，加上有人员与行政任一分区权限时的「WCP 设置」（进第一个能进的分区） */
export function useWcpNav(): WcpNavItem[] {
  const can = useCan();
  const session = useSession();
  const wcp = visibleBoardSections('wcp', can, session.erpModules);
  return wcp.length
    ? [
        ...WCP_TILES,
        { to: ADMIN_SECTIONS[wcp[0]!].path, label: 'WCP 设置', hint: '员工账号、组织架构、考勤、审批模板、工资条、员工培训、食堂与巡场', icon: SlidersHorizontal, testId: 'oa-tile-settings' },
      ]
    : [...WCP_TILES];
}

/**
 * 手机端底部 4 个 Tab（店主 2026-11-25《员工办公系统建设需求文档 v1.1》第二节，参考钉钉排版；docs/OA_MOBILE.md）：
 * 工作台、消息、知识库（员工培训，店主确认就是 WCP 知识模块）、我的。宽屏照旧是左边一列，不出这一排。
 * 没列在别的 Tab 里的页面（打卡、审批、工资条……）都算工作台下面的。
 */
export interface WcpTab {
  key: 'work' | 'messages' | 'knowledge' | 'me';
  to: string;
  label: string;
  icon: LucideIcon;
  /** 这些地址开头的页面亮这个 Tab */
  prefixes: readonly string[];
}
export const WCP_TABS: readonly WcpTab[] = [
  { key: 'work', to: '/oa', label: '工作台', icon: LayoutGrid, prefixes: [] },
  { key: 'messages', to: '/oa/im', label: '消息', icon: MessagesSquare, prefixes: ['/oa/im', '/oa/notifications'] },
  { key: 'knowledge', to: '/oa/training', label: '知识库', icon: BookOpen, prefixes: ['/oa/training'] },
  { key: 'me', to: '/oa/me', label: '我的', icon: UserRound, prefixes: ['/oa/me', '/oa/leave', '/oa/face'] },
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** 地址属于哪个 Tab */
export function wcpTabOf(pathname: string): WcpTab {
  const path = pathname.replace(/\/+$/, '') || '/oa';
  return WCP_TABS.find((t) => t.prefixes.some((p) => under(path, p))) ?? WCP_TABS[0]!;
}

/** 是不是某个 Tab 的首页（手机顶栏上不出「返回」） */
export function isWcpTabRoot(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/oa';
  return WCP_TABS.some((t) => t.to === path);
}
