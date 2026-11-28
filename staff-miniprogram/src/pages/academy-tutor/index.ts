// 问柚子（docs/STAFF_MP.md 第 2.3 节，第二版）：就这门课的课件问问题，柚子只按课件回答、写出处；每人每天有次数上限（学堂定）。
// 照学堂的 /api/academy/courses/:id/tutor：
//   · 提问带操作编号，先存在手机上再发（结果待确认）：模型要想一会儿，常常比小程序等回复的 15 秒长——没收到回复就隔几秒原样重提
//     （门店系统按编号认出来，回原来那个问题现在的样子，不会多问一次、不多算次数），回的是「在想」就隔几秒刷新一次，直到答完；
//   · 门店没配模型服务的，写清楚、不给问。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import type { AcademyTutorAnswer } from '../../../../src/shared/academy';
import type { TutorRow } from '../../utils/academy';
import { loadTutor, tutorLine, tutorRow } from '../../utils/academy';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import type { PendingOp } from '../../utils/pending';
import { loadPending, SAVE_FAILED, sendPending } from '../../utils/pending';
import { largeTextOn } from '../../utils/prefs';
import { uuid } from '../../utils/uuid';

const QUESTION_MAX = 300;
/** 没收到回复、在想的：隔几秒再问一次门店系统；最多等这么久（模型调用最长也就几分钟） */
const POLL_MS = 5000;
const POLL_LIMIT = 36;

let me: StaffMpMe | null = null;
let gen = 0;
let timer: number | null = null;
let polls = 0;

Page({
  data: {
    large: false,
    courseId: 0,
    title: '问柚子',
    state: 'loading',
    error: '',
    rows: [] as TutorRow[],
    line: '',
    off: false,
    question: '',
    busy: false,
    waiting: false,
    notice: '',
    noticeTone: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ large: largeTextOn(), courseId: Number(q.course) || 0, title: q.title ? `问柚子 · ${decodeURIComponent(q.title)}` : '问柚子' });
  },

  async onShow() {
    me = await requireMe();
    if (!me) return;
    await this.load();
    // 手机上留着这门课没收到回复的那个问题：先原样重提掉
    if (me && loadPending(me.staff.id, 'academy_tutor', this.data.courseId)) this.resend();
  },

  onHide() {
    this.stop();
  },

  onUnload() {
    this.stop();
  },

  stop() {
    gen += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  },

  async load() {
    const my = ++gen;
    try {
      const v = await loadTutor(this.data.courseId);
      if (my !== gen) return;
      const answering = v.items.some((x) => x.status === 'answering');
      this.setData({ state: 'ready', error: '', rows: v.items.slice().reverse().map(tutorRow), line: tutorLine(v), off: v.mode === 'off', waiting: answering });
      if (answering) this.later(() => this.load());
      else polls = 0;
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      if (this.data.state !== 'ready') this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  /** 隔几秒再做一次（在想的刷新、没收到回复的重提）；等太久就停下、请员工下拉刷新 */
  later(fn: () => void) {
    if (timer !== null) clearTimeout(timer);
    if (polls >= POLL_LIMIT) {
      polls = 0;
      this.setData({ waiting: false, notice: '柚子想了很久还没答完：过一会儿下拉刷新看看', noticeTone: 'warn' });
      return;
    }
    polls += 1;
    const my = gen;
    timer = setTimeout(() => {
      timer = null;
      if (my === gen) fn();
    }, POLL_MS) as unknown as number;
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ question: e.detail.value.slice(0, QUESTION_MAX), notice: '' });
  },

  async onAsk() {
    if (!me || this.data.busy || this.data.off) return;
    const question = this.data.question.trim();
    if (question.length < 2) return void this.setData({ notice: '问题太短了，多写几个字', noticeTone: 'error' });
    const key = uuid();
    const op: PendingOp = { staffId: me.staff.id, kind: 'academy_tutor', ref: this.data.courseId, key, path: `/academy/courses/${this.data.courseId}/tutor`, body: { clientKey: key, question }, at: Date.now(), label: '问柚子' };
    await this.send(op);
  },

  async resend() {
    const p = me ? loadPending(me.staff.id, 'academy_tutor', this.data.courseId) : null;
    if (p) await this.send(p);
  },

  async send(op: PendingOp): Promise<void> {
    if (this.data.busy) return;
    const my = gen;
    this.setData({ busy: true, notice: '' });
    const out = await sendPending<AcademyTutorAnswer>(op);
    if (my !== gen) return;
    this.setData({ busy: false });
    if (out.status === 'ok') {
      polls = 0;
      this.setData({ question: '' });
      await this.load();
      return;
    }
    if (out.status === 'signed_out') return toLogin();
    if (out.status === 'not_sent') return void this.setData({ notice: SAVE_FAILED, noticeTone: 'error' });
    if (out.status === 'blocked') {
      // 这门课上一个问题还没确定：先把那一个原样重提掉
      this.setData({ notice: '上一个问题还没收到回复，先把它问完', noticeTone: 'warn' });
      return this.send(out.pending);
    }
    if (out.status === 'rejected') return void this.setData({ notice: messageOf(out.error), noticeTone: 'error' });
    // 没收到回复：柚子可能还在想，隔几秒原样重提（不会多问一次）
    this.setData({ waiting: true, notice: 'error' in out && isOffline(out.error) ? '连不上门店系统，连上以后接着问' : '柚子还在想，等一下', noticeTone: 'warn' });
    this.later(() => this.resend());
  },

  async onPullDownRefresh() {
    polls = 0;
    await this.load();
    if (me && loadPending(me.staff.id, 'academy_tutor', this.data.courseId)) await this.resend();
    wx.stopPullDownRefresh();
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },
});
