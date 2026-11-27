// 申请与审批（docs/STAFF_MP.md 第 2.4 节，SP07）：三个页签——待我审批、我发起的、抄送我的（GET /api/oa/approvals?box=todo|mine|cc），
// 页签上的数字来自 /api/oa/approvals/summary；底下固定一个「发起申请」。往下滑接着取更早的。

import type { ApprovalBox, ApprovalListItem, ApprovalPage, ApprovalSummary } from '../../../../src/shared/oa-approval';
import { call, isApiError, isOffline, messageOf } from '../../utils/api';
import { STATUS_LABELS } from '../../utils/approval-form';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';

interface Row {
  id: number;
  title: string;
  sub: string;
  status: string;
  statusText: string;
  unread: boolean;
}

const TABS: { box: ApprovalBox; label: string }[] = [
  { box: 'todo', label: '待我审批' },
  { box: 'mine', label: '我发起的' },
  { box: 'cc', label: '抄送我的' },
];

function rowOf(box: ApprovalBox, a: ApprovalListItem): Row {
  const who = box === 'mine' ? (a.status === 'pending' && a.currentApproverName ? `等 ${a.currentApproverName} 审批` : '') : a.applicantName;
  return {
    id: a.id,
    title: a.title,
    sub: [who, shortTime(a.submittedAt)].filter(Boolean).join(' · '),
    status: a.status,
    statusText: STATUS_LABELS[a.status] ?? a.status,
    unread: box === 'cc' && !a.ccReadAt,
  };
}

let seq = 0;

Page({
  data: {
    large: false,
    tabs: TABS,
    box: 'todo' as ApprovalBox,
    counts: { todo: 0, cc: 0 } as Record<string, number>,
    state: 'loading',
    error: '',
    rows: [] as Row[],
    next: null as number | null,
    loadingMore: false,
  },

  onLoad(q: Record<string, string | undefined>) {
    if (q.box === 'mine' || q.box === 'cc' || q.box === 'todo') this.setData({ box: q.box });
  },

  async onShow() {
    this.setData({ large: largeTextOn() });
    if (!(await requireMe())) return;
    this.load();
  },

  async load() {
    const box = this.data.box;
    const mine = ++seq;
    try {
      const [page, summary] = await Promise.all([call<ApprovalPage>('GET', `/oa/approvals?box=${box}`), call<ApprovalSummary>('GET', '/oa/approvals/summary')]);
      if (mine !== seq) return;
      const rows = page.items.map((a) => rowOf(box, a));
      this.setData({ rows, next: page.next, counts: { todo: summary.todo, cc: summary.ccUnread }, state: rows.length ? 'ready' : 'empty', error: '' });
    } catch (e) {
      if (mine !== seq) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  async onReachBottom() {
    const { next, box, loadingMore } = this.data;
    if (!next || loadingMore) return;
    this.setData({ loadingMore: true });
    try {
      const page = await call<ApprovalPage>('GET', `/oa/approvals?box=${box}&before=${next}`);
      if (box !== this.data.box) return;
      this.setData({ rows: this.data.rows.concat(page.items.map((a) => rowOf(box, a))), next: page.next });
    } catch {
      // 下一页没取到：再往下滑会再试
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  onTab(e: WechatMiniprogram.TouchEvent) {
    const box = e.currentTarget.dataset.box as ApprovalBox;
    if (box === this.data.box) return;
    this.setData({ box, state: 'loading', rows: [], next: null });
    this.load();
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  onOpen(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/approval/index?id=${e.currentTarget.dataset.id}` });
  },

  onApply() {
    wx.navigateTo({ url: '/pages/apply/index' });
  },
});
