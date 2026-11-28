// 审批单详情（docs/STAFF_MP.md 第 2.4 节）：表单内容、附件（图片用短时地址看缩略图）、审批流程与时间线；
// 轮到我审批的给「同意」「驳回」（驳回要写原因），自己发起的审批中能「撤销」「催办」；抄送给我的打开就记已读。
// 处理带操作编号，没收到结果的进「结果待确认」，只能原样重提（门店系统按编号认出来，处理过的回原来那一次）。

import type { StaffMpMe, StaffMpMediaLink } from '../../../../src/shared/staffmp';
import type { OaAttachment } from '../../../../src/shared/oa';
import type { ApprovalDetail, ApprovalSaved } from '../../../../src/shared/oa-approval';
import { absoluteUrl, call, download, isApiError, isOffline, messageOf } from '../../utils/api';
import { EVENT_LABELS, STATUS_LABELS, valueText } from '../../utils/approval-form';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import type { PendingOp } from '../../utils/pending';
import { loadPending, SAVE_FAILED, sendPending } from '../../utils/pending';
import { largeTextOn } from '../../utils/prefs';
import { markRejectedSeen } from '../../utils/seen';
import { uuid } from '../../utils/uuid';

interface FieldRow {
  key: string;
  label: string;
  text: string;
}
interface AttachmentRow {
  id: number;
  name: string;
  isImage: boolean;
  thumb: string;
}

let me: StaffMpMe | null = null;

const ACTION_LABELS: Record<string, string> = { approve: '同意', reject: '驳回', withdraw: '撤销', urge: '催办' };

let detail: ApprovalDetail | null = null;

/** 请假时长、加班小时等由门店系统算好放进表单的（与 WCP 网页 derivedText 同一口径） */
function derived(d: ApprovalDetail): string {
  const f = d.form as Record<string, unknown>;
  if (d.templateCode === 'leave' && typeof f.durationHalves === 'number') return `共 ${f.durationHalves / 2} 天`;
  if (d.templateCode === 'overtime' && typeof f.minutes === 'number') return `共 ${Math.round((f.minutes / 60) * 10) / 10} 小时`;
  if (d.templateCode === 'trip' && typeof f.days === 'number') return `共 ${f.days} 天`;
  return '';
}

Page({
  data: {
    large: false,
    id: 0,
    state: 'loading',
    error: '',
    title: '',
    status: '',
    statusText: '',
    meta: '',
    derived: '',
    fields: [] as FieldRow[],
    attachments: [] as AttachmentRow[],
    steps: [] as { id: number; label: string; who: string; status: string; comment: string }[],
    events: [] as { id: number; text: string; time: string; comment: string }[],
    can: { approve: false, reject: false, withdraw: false, urge: false },
    comment: '',
    busy: false,
    actionError: '',
    pending: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ large: largeTextOn(), id: Number(q.id) || 0 });
  },

  async onShow() {
    me = await requireMe();
    if (!me) return;
    this.showPending();
    this.load();
  },

  showPending() {
    const p = me ? loadPending(me.staff.id, 'approval_act', this.data.id) : null;
    this.setData({ pending: p ? `${shortTime(new Date(p.at).toISOString())} 的「${p.label}」没收到门店系统的回复，可能已经处理了。` : '' });
  },

  async load() {
    try {
      const d = await call<ApprovalDetail>('GET', `/oa/approvals/${this.data.id}`);
      detail = d;
      let leaveTypes: Record<number, string> = {};
      if (d.fields.some((f) => f.type === 'leave_type')) {
        try {
          const l = await call<{ types: { id: number; name: string }[] }>('GET', '/oa/me/leave');
          leaveTypes = Object.fromEntries(l.types.map((t) => [t.id, t.name]));
        } catch {
          leaveTypes = {};
        }
      }
      const fields = d.fields.filter((f) => f.type !== 'attachments').map((f) => ({ key: f.key, label: f.label, text: valueText(f, (d.form as Record<string, unknown>)[f.key], { leaveTypes }) }));
      this.setData({
        state: 'ready',
        error: '',
        title: d.title,
        status: d.status,
        statusText: STATUS_LABELS[d.status] ?? d.status,
        meta: `${d.applicantName} · ${shortTime(d.submittedAt)} 提交${d.revision > 1 ? ` · 第 ${d.revision} 版` : ''}`,
        derived: derived(d),
        fields,
        attachments: d.attachments.map((a) => ({ id: a.id, name: a.fileName, isImage: a.isImage, thumb: '' })),
        steps: d.steps.map((s) => ({ id: s.id, label: s.label, who: s.transferredToName ? `${s.approverName} → ${s.transferredToName}` : s.approverName, status: s.status, comment: s.comment })),
        events: d.events.map((e) => ({ id: e.id, text: `${e.actorName} ${EVENT_LABELS[e.kind] ?? e.kind}${e.toName ? `给 ${e.toName}` : ''}`, time: shortTime(e.createdAt), comment: e.comment })),
        can: { approve: d.can.approve, reject: d.can.reject, withdraw: d.can.withdraw, urge: d.can.urge },
      });
      this.loadThumbs(d.attachments);
      // 我的申请被驳回了：打开看过，首页待办就不再提它（只记在这台手机上，SP19）
      if (me && d.status === 'rejected' && d.applicantId === me.staff.id) markRejectedSeen(me.staff.id, d.id);
      // 抄送给我的：打开就记已读（不等结果）
      // 抄送里有我、我还没看过才记（审批人、发起人打开不记）
      const viewer = me;
      if (d.ccReadAt === null && viewer && d.cc.some((c) => c.staffId === viewer.staff.id)) call('POST', `/oa/approvals/${d.id}/read`, {}).catch(() => undefined);
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  /** 图片附件的缩略图：要短时地址（<image> 带不了请求头） */
  async loadThumbs(list: OaAttachment[]) {
    for (const a of list) {
      if (!a.isImage) continue;
      try {
        const link = await call<StaffMpMediaLink>('POST', '/media', { kind: a.hasThumb ? 'thumb' : 'attachment', id: a.id });
        const rows = this.data.attachments.map((x) => (x.id === a.id ? { ...x, thumb: absoluteUrl(link.url) } : x));
        this.setData({ attachments: rows });
      } catch {
        // 缩略图没取到：只显示文件名，点开照样能看
      }
    }
  },

  async onAttachment(e: WechatMiniprogram.TouchEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const a = detail?.attachments.find((x) => x.id === id);
    if (!a) return;
    try {
      if (a.isImage) {
        const link = await call<StaffMpMediaLink>('POST', '/media', { kind: 'attachment', id });
        wx.previewImage({ urls: [absoluteUrl(link.url)] });
        return;
      }
      // 先看小程序打不打得开，打不开的不下载（最大 10MB）
      const ext = (/\.([a-z0-9]+)$/i.exec(a.fileName)?.[1] ?? '').toLowerCase();
      if (!['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) {
        this.setData({ actionError: '这种附件小程序里打不开，请在电脑上的 WCP 里看' });
        return;
      }
      const path = await download(`/oa/attachments/${id}`);
      wx.openDocument({ filePath: path, fileType: ext as 'pdf', showMenu: false, fail: () => this.setData({ actionError: '附件没有打开，请再试一次' }) });
    } catch (err) {
      this.setData({ actionError: messageOf(err) });
    }
  },

  onComment(e: WechatMiniprogram.Input) {
    this.setData({ comment: e.detail.value, actionError: '' });
  },

  onApprove() {
    this.act('approve');
  },

  onReject() {
    if (!this.data.comment.trim()) return this.setData({ actionError: '驳回要写原因，写在上面的意见里' });
    this.act('reject');
  },

  onWithdraw() {
    wx.showModal({
      title: '撤销这张申请？',
      content: '撤销以后审批人就不用再处理了；要的话可以重新发起。',
      confirmText: '撤销',
      cancelText: '先不撤销',
      success: (r) => {
        if (r.confirm) this.act('withdraw');
      },
    });
  },

  onUrge() {
    this.act('urge');
  },

  async act(action: 'approve' | 'reject' | 'withdraw' | 'urge') {
    if (this.data.busy || !detail || !me) return;
    const body: Record<string, unknown> = { action, clientKey: uuid() };
    if (action === 'approve' || action === 'reject') {
      if (!detail.pendingStepId) return this.setData({ actionError: '这一步刚被别人处理了，下拉刷新看最新的' });
      body.stepId = detail.pendingStepId;
    }
    if (action !== 'urge') body.comment = this.data.comment.trim();
    const op: PendingOp = {
      staffId: me.staff.id,
      kind: 'approval_act',
      ref: detail.id,
      key: String(body.clientKey),
      path: `/oa/approvals/${detail.id}/act`,
      body,
      at: Date.now(),
      label: ACTION_LABELS[action] ?? action,
    };
    await this.send(op);
  },

  async send(op: PendingOp) {
    this.setData({ busy: true, actionError: '' });
    try {
      const r = await sendPending<ApprovalSaved>(op);
      if (r.status === 'not_sent') return this.setData({ actionError: SAVE_FAILED });
      if (r.status === 'signed_out') return toLogin();
      if (r.status === 'blocked') {
        this.showPending();
        return this.setData({ actionError: '上一次处理还没确定：先点「再提交一次」，拿到结果再说' });
      }
      if (r.status === 'ok' || r.status === 'confirmed') {
        // confirmed：门店系统查到那一次已经办了（拿不回当时的结果），与办好了一样，重新取这张单
        wx.showToast({ title: op.label === '催办' ? '已催办' : `已${op.label}`, icon: 'success', duration: 1500 });
        this.setData({ comment: '', pending: '' });
        await this.load();
        return;
      }
      if (r.status === 'rejected') {
        this.setData({ actionError: messageOf(r.error) });
        this.showPending();
        return;
      }
      this.showPending();
    } finally {
      this.setData({ busy: false });
    }
  },

  async onResend() {
    const p = me ? loadPending(me.staff.id, 'approval_act', this.data.id) : null;
    if (p) await this.send(p);
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },
});
