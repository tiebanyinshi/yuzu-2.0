// 学堂的每日一练（docs/ACADEMY.md 第 7.2 节，FSRS）：今天该复习的题与几道新题，一题一题来。
//   · 客观题：选了点「交」，门店系统判对错、给答案与解析、算下次什么时候再出；
//   · 问答卡：先自己想，点「看答案」再自评（忘了 / 模糊 / 记得 / 很熟）。
// 作答带操作编号，先存在手机上再发（「结果待确认」，AGENTS.md）：没收到回复的只能原样重提，门店系统按编号认出来回同一次。
//   · 同一天、同一道题留着没确定的：这道题一出来就是「再交一次」（交的是原来那一次），不让重新作答；
//   · 以前哪天留着的：进来先在后台原样重提掉（门店系统回那一次的结果），再取今天的题。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import type { AcademyDaily, AcademyDailyAnswer } from '../../../../src/shared/academy';
import type { OptionView } from '../../utils/academy';
import { dailyAnswerLine, dailyLine, GRADES, loadDaily, optionViews, toggleChoice } from '../../utils/academy';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import type { PendingOp } from '../../utils/pending';
import { listPending, loadPending, SAVE_FAILED, sendPending } from '../../utils/pending';
import { storeClock } from '../../utils/format';
import { largeTextOn } from '../../utils/prefs';
import { uuid } from '../../utils/uuid';

let me: StaffMpMe | null = null;
let daily: AcademyDaily | null = null;
let chosen: number[] = [];
let gen = 0;
/** 每开一页加一、关掉也加一：交题的结果只认这一页（藏起来再回来照样画，免得一直卡在「交着」） */
let inst = 0;

const UNSURE = '没收到门店系统的回复，可能已经记上了：点下面的按钮原样再交一次（不会重复记）';

Page({
  data: {
    large: false,
    state: 'loading',
    error: '',
    idx: 0,
    total: 0,
    head: '',
    item: null as { stem: string; recall: boolean; multi: boolean; course: string; isNew: boolean; answerText: string } | null,
    opts: [] as OptionView[],
    canSubmit: false,
    showAnswer: false,
    answered: null as { line: string; ok: boolean | null; explanation: string; answerText: string } | null,
    busy: false,
    notice: '',
    unsure: false,
    /** 门店系统明确拒绝了这一题（题改过、停用了）：给「跳过」「刷新」 */
    rejected: false,
    finished: '',
    grades: GRADES,
  },

  onLoad() {
    daily = null;
    inst += 1;
    this.setData({ large: largeTextOn() });
  },

  onUnload() {
    inst += 1;
  },

  async onShow() {
    me = await requireMe();
    if (!me) return;
    if (!daily) this.load();
  },

  onHide() {
    gen += 1;
  },

  async load() {
    const my = ++gen;
    if (me) {
      // 以前哪天没确定的作答：原样重提掉（回那一次的结果），免得今天这道题一出来就被当成那一次
      const today = storeClock().date;
      const stale = listPending(me.staff.id, 'academy_daily').filter((op) => storeClock(new Date(op.at)).date < today);
      await Promise.all(stale.map((op) => sendPending(op).catch(() => undefined)));
      if (my !== gen) return;
    }
    try {
      const d = await loadDaily();
      if (my !== gen) return;
      daily = d;
      this.setData({ state: 'ready', error: '', total: d.items.length });
      this.show(0);
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  /** 画第 idx 题；都做完了画小结 */
  show(idx: number) {
    if (!daily) return;
    const it = daily.items[idx];
    chosen = [];
    if (!it) {
      this.setData({ item: null, answered: null, finished: dailyLine(daily), head: '' });
      return;
    }
    this.setData({
      idx,
      head: `第 ${idx + 1}/${daily.items.length} 题 · ${dailyLine(daily)}`,
      item: { stem: it.stem, recall: it.kind === 'recall', multi: it.kind === 'multi', course: it.courseTitle, isNew: it.isNew, answerText: it.answerText ?? '' },
      opts: optionViews(it.options, [], null),
      canSubmit: false,
      showAnswer: false,
      answered: null,
      notice: '',
      unsure: false,
      rejected: false,
      finished: '',
    });
    // 这道题今天交过、没收到回复的：只能原样再交那一次（标出当时选的）
    const prior = me ? loadPending(me.staff.id, 'academy_daily', it.questionId) : null;
    if (prior) {
      const sent = Array.isArray(prior.body.choice) ? (prior.body.choice as number[]) : [];
      chosen = sent;
      this.setData({ opts: optionViews(it.options, sent, null), showAnswer: it.kind === 'recall', notice: UNSURE, unsure: true });
    }
  },

  onOption(e: WechatMiniprogram.TouchEvent) {
    if (!daily || this.data.answered || this.data.busy || this.data.unsure) return;
    const it = daily.items[this.data.idx];
    if (!it) return;
    chosen = toggleChoice(chosen, Number((e.currentTarget.dataset as { option: number }).option), it.kind === 'multi');
    this.setData({ opts: optionViews(it.options, chosen, null), canSubmit: chosen.length > 0 });
  },

  onShowAnswer() {
    this.setData({ showAnswer: true });
  },

  onSubmit() {
    if (!chosen.length) return;
    this.send({ choice: chosen });
  },

  onGrade(e: WechatMiniprogram.TouchEvent) {
    this.send({ grade: Number((e.currentTarget.dataset as { grade: number }).grade) });
  },

  /** 交一题；这道题手机上留着没确定的那一次，就原样重提那一次 */
  async send(extra: Record<string, unknown>) {
    if (!me || !daily || this.data.busy) return;
    const it = daily.items[this.data.idx];
    if (!it) return;
    const prior = loadPending(me.staff.id, 'academy_daily', it.questionId);
    const key = prior ? prior.key : uuid();
    const body = prior ? prior.body : { clientKey: key, questionId: it.questionId, version: it.version, ...extra };
    const op: PendingOp = { staffId: me.staff.id, kind: 'academy_daily', key, path: '/academy/daily/answer', body, at: prior ? prior.at : Date.now(), label: '每日一练', ref: it.questionId };
    const mine = inst;
    this.setData({ busy: true, notice: '', unsure: false, rejected: false });
    const out = await sendPending<AcademyDailyAnswer>(op);
    if (mine !== inst) return;
    this.setData({ busy: false });
    if (out.status === 'ok') {
      const a = out.data;
      daily = { ...daily, doneToday: a.doneToday, target: a.target, credited: daily.credited || a.credits > 0 };
      this.setData({
        // 交上去的是哪几个（原样重提时是第一次交的那几个），标出对的与选错的
        opts: it.kind === 'recall' ? [] : optionViews(it.options, Array.isArray(body.choice) ? (body.choice as number[]) : [], a.answer),
        answered: { line: dailyAnswerLine(a, daily.today) + (a.credits > 0 ? ` · 今天的每日一练完成，+${a.credits} 学分` : ''), ok: a.correct, explanation: a.explanation, answerText: a.answerText },
        head: `第 ${this.data.idx + 1}/${daily.items.length} 题 · ${dailyLine(daily)}`,
      });
      if (a.correct) wx.vibrateShort({ type: 'light' });
      return;
    }
    if (out.status === 'signed_out') return toLogin();
    if (out.status === 'not_sent') return this.setData({ notice: SAVE_FAILED });
    if (out.status === 'rejected') return this.setData({ notice: messageOf(out.error), rejected: true });
    this.setData({ notice: UNSURE, unsure: true });
  },

  onSkip() {
    this.show(this.data.idx + 1);
  },

  onReload() {
    daily = null;
    this.setData({ state: 'loading', rejected: false, notice: '' });
    this.load();
  },

  onResend() {
    if (!me || !daily) return;
    const it = daily.items[this.data.idx];
    const prior = it ? loadPending(me.staff.id, 'academy_daily', it.questionId) : null;
    if (prior) this.send({});
    else this.setData({ unsure: false, notice: '' });
  },

  onNext() {
    this.show(this.data.idx + 1);
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/learn/index' }) });
  },
});
