// 学堂的测验（docs/ACADEMY.md 第 4 节）：开卷、答题、交卷、看每题对错与解析；及格了这一课时完成（学分、课程、地图由学堂算）。
// 「结果待确认」（AGENTS.md）：开卷带操作编号（门店系统按编号认出来，原样重提回同一份卷子）；交卷按卷子认（交过的原样回第一次的结果）。
// 两样都先存在手机上再发，没收到回复的只能原样重提。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import type { AcademyQuizResult, AcademyQuizView } from '../../../../src/shared/academy';
import type { OptionView } from '../../utils/academy';
import { completionText, loadQuizResult, optionViews, quizReady, quizResultLine, toggleChoice } from '../../utils/academy';
import { isOffline, messageOf } from '../../utils/api';
import { requireMe, toLogin } from '../../utils/guard';
import type { PendingOp } from '../../utils/pending';
import { listPending, loadPending, SAVE_FAILED, sendPending } from '../../utils/pending';
import { largeTextOn } from '../../utils/prefs';
import { uuid } from '../../utils/uuid';

interface QuestionRow {
  id: number;
  no: number;
  stem: string;
  multi: boolean;
  judge: boolean;
  opts: OptionView[];
}
interface ResultRow {
  no: number;
  stem: string;
  correct: boolean;
  opts: OptionView[];
  explanation: string;
}

let me: StaffMpMe | null = null;
let quiz: AcademyQuizView | null = null;
let answers: number[][] = [];
/** 每开一页加一：上一页（已经退出去的）晚到的开卷、交卷结果不动这一页 */
let inst = 0;

const UNSURE = '没收到门店系统的回复，可能已经办好了：点下面的按钮原样再发一次（同一份卷子，不会重复记）';

Page({
  data: {
    large: false,
    lessonId: 0,
    state: 'loading',
    error: '',
    /** 开卷没收到结果 / 交卷没收到结果 */
    unsure: '' as '' | 'start' | 'submit',
    questions: [] as QuestionRow[],
    ready: false,
    busy: false,
    result: null as { line: string; passed: boolean; completion: string; items: ResultRow[] } | null,
    error2: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    me = null;
    quiz = null;
    answers = [];
    inst += 1;
    this.setData({ large: largeTextOn(), lessonId: Number(q.lesson) || 0 });
  },

  onUnload() {
    inst += 1;
  },

  async onShow() {
    me = await requireMe();
    if (!me) return;
    if (!quiz && !this.data.result && !this.data.busy) this.start();
  },

  /** 开卷：手机上留着这一课时没确定的开卷，就原样重提那一次 */
  async start() {
    if (!me) return;
    const mine = inst;
    const lessonId = this.data.lessonId;
    // 以前交卷没收到回复、人走了的：先原样重提掉（交过的回第一次的结果），不在手机上一直留着
    for (const old of listPending(me.staff.id, 'academy_submit')) sendPending(old).catch(() => undefined);
    const prior = loadPending(me.staff.id, 'academy_quiz', lessonId);
    const key = prior ? prior.key : uuid();
    const op: PendingOp = { staffId: me.staff.id, kind: 'academy_quiz', key, path: `/academy/lessons/${lessonId}/quiz`, body: { clientKey: key }, at: prior ? prior.at : Date.now(), label: '开测验', ref: lessonId };
    this.setData({ busy: true, error: '', unsure: '' });
    const out = await sendPending<AcademyQuizView>(op);
    if (mine !== inst) return;
    this.setData({ busy: false });
    if (out.status === 'ok') {
      quiz = out.data;
      // 原样重提时这份卷子已经交过了：直接看结果
      if (quiz.submitted) {
        const r = await loadQuizResult(quiz.attemptId).catch(() => null);
        if (mine === inst) this.showResult(r);
        return;
      }
      answers = quiz.questions.map(() => []);
      this.render();
      return;
    }
    if (out.status === 'signed_out') return toLogin();
    if (out.status === 'not_sent') return this.setData({ state: 'error', error: SAVE_FAILED });
    if (out.status === 'rejected') return this.setData({ state: 'error', error: messageOf(out.error) });
    this.setData({ state: 'ready', unsure: 'start', error: out.status === 'unknown' && isOffline(out.error) ? `连不上门店系统。${UNSURE}` : UNSURE });
  },

  render() {
    if (!quiz) return;
    const questions = quiz.questions.map((q, k) => ({
      id: q.id,
      no: k + 1,
      stem: q.stem,
      multi: q.kind === 'multi',
      judge: q.kind === 'judge',
      opts: optionViews(q.options, answers[k] ?? [], null),
    }));
    this.setData({ state: 'ready', questions, ready: quizReady(quiz.questions, answers) });
  },

  onOption(e: WechatMiniprogram.TouchEvent) {
    // 交卷没收到回复的时候不改：再交一次交的是原来那一份
    if (!quiz || this.data.busy || this.data.unsure === 'submit') return;
    const { q, option } = e.currentTarget.dataset as { q: number; option: number };
    const item = quiz.questions[q];
    if (!item) return;
    answers[q] = toggleChoice(answers[q] ?? [], option, item.kind === 'multi');
    this.setData({ [`questions[${q}].opts`]: optionViews(item.options, answers[q]!, null), ready: quizReady(quiz.questions, answers) });
  },

  /** 交卷：没确定的那一次原样重提（同一份卷子交过的门店系统回第一次的结果） */
  async onSubmit() {
    if (!me || !quiz || this.data.busy) return;
    if (!quizReady(quiz.questions, answers)) return;
    const mine = inst;
    const prior = loadPending(me.staff.id, 'academy_submit', quiz.attemptId);
    const body = prior ? prior.body : { answers };
    const op: PendingOp = { staffId: me.staff.id, kind: 'academy_submit', key: prior ? prior.key : uuid(), path: `/academy/attempts/${quiz.attemptId}/submit`, body, at: prior ? prior.at : Date.now(), label: '交卷', ref: quiz.attemptId };
    this.setData({ busy: true, error2: '', unsure: '' });
    const out = await sendPending<AcademyQuizResult>(op);
    if (mine !== inst) return;
    this.setData({ busy: false });
    if (out.status === 'ok') return this.showResult(out.data);
    if (out.status === 'signed_out') return toLogin();
    if (out.status === 'not_sent') return this.setData({ error2: SAVE_FAILED });
    if (out.status === 'rejected') return this.setData({ error2: messageOf(out.error) });
    this.setData({ unsure: 'submit', error2: UNSURE });
  },

  onResend() {
    if (this.data.unsure === 'start') this.start();
    else if (this.data.unsure === 'submit') this.onSubmit();
  },

  showResult(r: AcademyQuizResult | null) {
    if (!r) return this.setData({ state: 'error', error: '这份卷子已经交过了，结果没取回来：回到课时再看「最好成绩」' });
    if (r.passed) wx.vibrateShort({ type: 'light' });
    this.setData({
      state: 'ready',
      unsure: '',
      result: {
        line: quizResultLine(r),
        passed: r.passed,
        completion: completionText(r.completion),
        items: r.items.map((it, k) => ({ no: k + 1, stem: it.stem, correct: it.correct, opts: optionViews(it.options, it.chosen, it.answer), explanation: it.explanation })),
      },
    });
  },

  onAgain() {
    quiz = null;
    answers = [];
    this.setData({ result: null, questions: [], state: 'loading' });
    this.start();
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.redirectTo({ url: `/pages/academy-lesson/index?id=${this.data.lessonId}` }) });
  },
});
