// 签一项实操（docs/STAFF_MP.md 第 2.3 节，第二版）：照学堂的检查项一项一项点「达标 / 没达标」，再签「通过」（每项都达标）或「再练」，
// 可以写评语。签核带操作编号、带这一版检查项的版本（管理员改过检查项就拒绝，请刷新再签）；先存在手机上再发（结果待确认）：
// 没收到回复的只能原样再提交（门店系统按编号认出来，不会签两次），没确定以前这一项不让重新填。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import type { AcademyCoachItem, AcademySignoff } from '../../../../src/shared/academy';
import { loadCoachQueue, signoffReady } from '../../utils/academy';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import type { PendingOp } from '../../utils/pending';
import { loadPending, SAVE_FAILED, sendPending } from '../../utils/pending';
import { buzz, largeTextOn } from '../../utils/prefs';
import { uuid } from '../../utils/uuid';

let me: StaffMpMe | null = null;
let item: AcademyCoachItem | null = null;
let gen = 0;

const refOf = (staffId: number, lessonId: number) => `${staffId}-${lessonId}`;

Page({
  data: {
    large: false,
    staffId: 0,
    lessonId: 0,
    state: 'loading',
    error: '',
    name: '',
    title: '',
    course: '',
    last: '',
    checks: [] as { text: string; value: boolean | null }[],
    result: '' as '' | 'pass' | 'retry',
    comment: '',
    busy: false,
    actionError: '',
    pending: '',
    done: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    me = null;
    item = null;
    this.setData({ large: largeTextOn(), staffId: Number(q.staff) || 0, lessonId: Number(q.lesson) || 0 });
  },

  async onShow() {
    me = await requireMe();
    if (!me || this.data.done) return;
    this.showPending();
    if (!item) await this.load();
  },

  onHide() {
    gen += 1;
  },

  onUnload() {
    gen += 1;
  },

  showPending() {
    const p = me ? loadPending(me.staff.id, 'academy_signoff', refOf(this.data.staffId, this.data.lessonId)) : null;
    if (!p) return this.setData({ pending: '' });
    // 留着没确定的那一次：表单照那一次的内容显示（只能原样再提交）
    const b = p.body as { checks: boolean[]; result: 'pass' | 'retry'; comment: string };
    this.setData({
      pending: `${shortTime(new Date(p.at).toISOString())} 签的这一项没收到门店系统的回复，可能已经签上了：点「再提交一次」，签上了的会认出来，不会签两次`,
      result: b.result,
      comment: b.comment,
      checks: this.data.checks.length === b.checks.length ? this.data.checks.map((c, k) => ({ ...c, value: b.checks[k]! })) : this.data.checks,
    });
  },

  async load() {
    const my = ++gen;
    try {
      const list = await loadCoachQueue();
      if (my !== gen) return;
      item = list.find((x) => x.staffId === this.data.staffId && x.lessonId === this.data.lessonId) ?? null;
      if (!item) return this.setData({ state: 'empty' });
      this.setData({
        state: 'ready',
        error: '',
        name: item.name,
        title: item.lessonTitle,
        course: item.courseTitle,
        last: item.last ? `上次 ${item.last.signedByName} 签了「${item.last.result === 'pass' ? '通过' : '再练'}」` : '',
        checks: item.items.map((text) => ({ text, value: null })),
      });
      this.showPending();
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onCheck(e: WechatMiniprogram.TouchEvent) {
    if (this.data.pending || this.data.busy) return;
    const { i, v } = e.currentTarget.dataset as { i: number; v: string };
    this.setData({ [`checks[${i}].value`]: v === 'ok', actionError: '' });
  },

  onResult(e: WechatMiniprogram.TouchEvent) {
    if (this.data.pending || this.data.busy) return;
    this.setData({ result: String(e.currentTarget.dataset.v) as 'pass' | 'retry', actionError: '' });
  },

  onComment(e: WechatMiniprogram.Input) {
    if (this.data.pending) return;
    this.setData({ comment: e.detail.value.slice(0, 300) });
  },

  async onSubmit() {
    if (!me || !item || this.data.busy || this.data.pending) return;
    const checks = this.data.checks.map((c) => c.value);
    const ready = signoffReady(checks, this.data.result);
    if (!ready.ok) return this.setData({ actionError: ready.why });
    const key = uuid();
    const op: PendingOp = {
      staffId: me.staff.id,
      kind: 'academy_signoff',
      ref: refOf(item.staffId, item.lessonId),
      key,
      path: '/academy/signoffs',
      body: { clientKey: key, staffId: item.staffId, lessonId: item.lessonId, lessonVersion: item.lessonVersion, checks: checks as boolean[], result: this.data.result, comment: this.data.comment.trim() },
      at: Date.now(),
      label: `给${item.name}签实操`,
    };
    await this.send(op);
  },

  async onResend() {
    const p = me ? loadPending(me.staff.id, 'academy_signoff', refOf(this.data.staffId, this.data.lessonId)) : null;
    if (p) await this.send(p);
  },

  async send(op: PendingOp) {
    const my = gen;
    this.setData({ busy: true, actionError: '' });
    const out = await sendPending<{ signoff: AcademySignoff; completed: boolean; credits: number }>(op);
    if (my !== gen) return;
    this.setData({ busy: false });
    if (out.status === 'ok') {
      buzz();
      const r = out.data;
      this.setData({ pending: '', done: r.completed ? `签了「通过」：这一项实操完成了${r.credits ? `，${this.data.name}得 ${r.credits} 学分` : ''}` : '签了「再练」：练好了再签' });
      return;
    }
    if (out.status === 'signed_out') return toLogin();
    if (out.status === 'not_sent') return this.setData({ actionError: SAVE_FAILED });
    if (out.status === 'rejected') {
      // 检查项改过、已经签过「通过」：重新取这一项
      this.setData({ actionError: messageOf(out.error), pending: '' });
      if (isApiError(out.error) && (out.error.code === 'ACADEMY_CHANGED' || out.error.code === 'ACADEMY_ALREADY_DONE')) {
        item = null;
        await this.load();
      }
      return;
    }
    this.showPending();
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/academy-coach/index' }) });
  },

  async onPullDownRefresh() {
    if (!this.data.done) {
      item = null;
      await this.load();
    }
    wx.stopPullDownRefresh();
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },
});
