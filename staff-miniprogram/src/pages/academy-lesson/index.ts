// 学堂的一个课时（docs/STAFF_MP.md 第 2.3 节「课件是阅读屏」）：
//   · 图文课件：按门店系统解析好的块画（正文、要点 / 注意 / 禁忌、步骤、翻牌卡、表格、情景选择、课中小测）；课中小测都答过才能点「学完了」；
//   · 视频 / 文件：在知识库的文件页里看（同一份文件、同一条「看过」），看过才能点「学完了」；
//   · 测验：去测验页（开卷、交卷都带编号）；实操：列出检查项与带教签过的记录（带教在 WCP 网页上签）。
// 打开时报一次 0 秒（学堂记下「开始学了」，实操课时由此进带教的待签）；图文课件、文件开着每 30 秒报一次学习时长
// （学堂按两次上报的间隔算、封顶，同时开几个课时不重复计）；去文件页看文件时照样计（与学堂网页一样）。
// 「学完了」照「结果待确认」（AGENTS.md）先存在手机上再发，存不下就不发；没收到回复的留着，回到这一课时只能原样再点一次
// （学堂一个课时只给一次学分，重提不会重复加分）。文件课时要在文件页里真打开、真放出来过才能点。

import type { StaffMpMe } from '../../../../src/shared/staffmp';
import type { AcademyCompletion } from '../../../../src/shared/academy';
import type { BlockView, QuestionState } from '../../utils/academy';
import { blockViews, completionText, KIND_LABELS, loadLesson, PING_SECONDS, pingLesson, questionState, toggleChoice, unansweredCount } from '../../utils/academy';
import { isApiError, isOffline, messageOf } from '../../utils/api';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import type { PendingOp } from '../../utils/pending';
import { clearPending, loadPending, SAVE_FAILED, sendPending } from '../../utils/pending';
import { largeTextOn } from '../../utils/prefs';
import { openedSince } from '../../utils/training';
import { uuid } from '../../utils/uuid';

let gen = 0;
// 计时只给正在显示的那一页（同一时刻只有一页在前台；去文件页看文件时留给这一页）
let timer: number | null = null;
let lastPing = 0;
/** 去文件页看文件了：这一页藏起来时不停计时 */
let inFile = false;
/** 去文件页的时刻：回来以后看这之后真打开过那份文件没有 */
let fileFrom = 0;
let me: StaffMpMe | null = null;

const UNSURE = '上次点「学完了」没收到门店系统的回复，可能已经记上了：再点一次「学完了」原样再发（不会重复加学分）';

function stopTimer() {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** 这几种课时页面开着就计时（测验在测验页、实操在岗位上，不计） */
const TIMED = ['article', 'file'];

Page({
  data: {
    large: false,
    id: 0,
    state: 'loading',
    error: '',
    kind: '',
    kindLabel: '',
    title: '',
    courseTitle: '',
    courseId: 0,
    meta: '',
    done: false,
    nextId: 0,
    blocks: [] as BlockView[],
    left: 0,
    file: null as { id: number; folderId: number; title: string } | null,
    opened: false,
    quiz: null as { count: number; pass: number; best: string; available: number } | null,
    practical: null as { items: string[]; signoffs: { id: number; text: string; comment: string }[] } | null,
    busy: false,
    notice: '',
    noticeTone: 'success',
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ large: largeTextOn(), id: Number(q.id) || 0 });
  },

  async onShow() {
    me = await requireMe();
    if (!me) return;
    // 从文件页回来：那段时间一直在计，接着计；别的情况重新起
    const back = inFile;
    inFile = false;
    // 真打开过、真放出来过才算看过（只是进了文件页又退回来的不算）
    if (back && this.data.file && openedSince(this.data.file.id, fileFrom)) this.setData({ opened: true });
    this.load();
    if (!back || timer === null) {
      lastPing = Date.now();
      this.startTimer();
    }
  },

  onHide() {
    gen += 1;
    // 去文件页看文件：照样计时（看视频的时间算在这一课时上）
    if (inFile) return;
    this.ping();
    stopTimer();
  },

  onUnload() {
    gen += 1;
    inFile = false;
    this.ping();
    stopTimer();
  },

  startTimer() {
    stopTimer();
    if (this.data.state === 'ready' && TIMED.indexOf(this.data.kind) < 0) return;
    timer = setInterval(() => this.ping(), PING_SECONDS * 1000) as unknown as number;
  },

  /** 报学习时长（失败就算了：学堂按下一次上报的间隔补算，最多 10 分钟） */
  ping() {
    const now = Date.now();
    const seconds = Math.min(600, Math.round((now - lastPing) / 1000));
    lastPing = now;
    if (seconds >= 5 && this.data.id && this.data.state === 'ready' && TIMED.indexOf(this.data.kind) >= 0) pingLesson(this.data.id, seconds).catch(() => undefined);
  },

  async load() {
    const my = ++gen;
    try {
      const v = await loadLesson(this.data.id);
      if (my !== gen) return;
      const l = v.lesson;
      // 第一次打开：报 0 秒，学堂记下「开始学了」（实操课时由此进带教的待签）
      if (this.data.state !== 'ready') pingLesson(l.id, 0).catch(() => undefined);
      // 已经在画的图文课件不重画（课中小测答到一半，切出去再回来不清掉）
      const keepBlocks = this.data.state === 'ready' && this.data.kind === 'article' && this.data.blocks.length > 0;
      const blocks = keepBlocks ? this.data.blocks : blockViews(v.blocks);
      const best = v.quizBest ? `最好成绩 ${v.quizBest.score} 分${v.quizBest.passed ? '（及格）' : ''}` : '还没考过';
      this.setData({
        state: 'ready',
        error: '',
        kind: l.kind,
        kindLabel: KIND_LABELS[l.kind],
        title: l.title,
        courseTitle: v.course.title,
        courseId: v.course.id,
        meta: `${KIND_LABELS[l.kind]} · 约 ${l.minutes} 分钟 · ${l.credits} 学分 · 已学 ${Math.round(v.seconds / 60)} 分钟`,
        done: l.state === 'done',
        nextId: v.nextId ?? 0,
        blocks,
        left: unansweredCount(blocks),
        file: v.file,
        quiz: l.kind === 'quiz' && l.quiz ? { count: l.quiz.count, pass: l.quiz.pass, best, available: v.quizAvailable } : null,
        practical: v.practical
          ? {
              items: v.practical.items,
              signoffs: v.practical.signoffs.map((s) => ({
                id: s.id,
                text: `${s.result === 'pass' ? '通过' : '再练练'} · ${s.signedByName} · ${shortTime(s.signedAt)}`,
                comment: s.comment,
              })),
            }
          : null,
      });
      // 不计时的课时（测验、实操）不留计时器
      if (TIMED.indexOf(l.kind) < 0) stopTimer();
      // 上次「学完了」没收到回复的：已经学完了就删掉，没有就提示只能原样再点一次
      const prior = me ? loadPending(me.staff.id, 'academy_complete', l.id) : null;
      if (prior && l.state === 'done' && me) clearPending(me.staff.id, 'academy_complete', l.id);
      else if (prior) this.setData({ notice: UNSURE, noticeTone: 'warn', opened: true, left: 0 });
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      if (this.data.state !== 'ready') this.setData({ state: isOffline(e) ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.setData({ state: 'loading' });
    this.load();
  },

  /** 改一道课中小测 */
  setQuestion(index: number, st: QuestionState) {
    const blocks = this.data.blocks.slice();
    const b = blocks[index];
    if (!b || b.type !== 'question') return;
    blocks[index] = { ...b, st };
    this.setData({ [`blocks[${index}]`]: blocks[index], left: unansweredCount(blocks) });
  },

  onOption(e: WechatMiniprogram.TouchEvent) {
    const { block, option } = e.currentTarget.dataset as { block: number; option: number };
    const b = this.data.blocks[block];
    if (!b || b.type !== 'question' || b.st.revealed) return;
    const chosen = toggleChoice(b.st.chosen, option, b.q.multi);
    // 单选、判断：点了就亮出答案；多选：选好了点「对答案」
    this.setQuestion(block, questionState(b.q, chosen, !b.q.multi));
  },

  onReveal(e: WechatMiniprogram.TouchEvent) {
    const { block } = e.currentTarget.dataset as { block: number };
    const b = this.data.blocks[block];
    if (!b || b.type !== 'question' || b.st.revealed) return;
    if (b.q.multi && !b.st.chosen.length) return;
    this.setQuestion(block, questionState(b.q, b.st.chosen, true));
  },

  onScenario(e: WechatMiniprogram.TouchEvent) {
    const { block, option } = e.currentTarget.dataset as { block: number; option: number };
    const b = this.data.blocks[block];
    if (!b || b.type !== 'scenario') return;
    this.setData({ [`blocks[${block}].picked`]: option });
  },

  onCard(e: WechatMiniprogram.TouchEvent) {
    const { block, card } = e.currentTarget.dataset as { block: number; card: number };
    const b = this.data.blocks[block];
    if (!b || b.type !== 'cards' || !b.cards[card]) return;
    this.setData({ [`blocks[${block}].cards[${card}].flipped`]: !b.cards[card]!.flipped });
  },

  onOpenFile() {
    const f = this.data.file;
    if (!f) return;
    inFile = true;
    fileFrom = Date.now();
    wx.navigateTo({ url: `/pages/learn-file/index?folder=${f.folderId}&id=${f.id}`, fail: () => (inFile = false) });
  },

  onQuiz() {
    wx.navigateTo({ url: `/pages/academy-quiz/index?lesson=${this.data.id}` });
  },

  async onComplete() {
    if (this.data.busy || this.data.done || !me) return;
    const id = this.data.id;
    const prior = loadPending(me.staff.id, 'academy_complete', id);
    // 留着没确定的那一次：原样再发（不看小测答没答、文件看没看——上次已经过了这一关）
    if (!prior) {
      if (this.data.kind === 'article' && this.data.left > 0) return;
      if (this.data.kind === 'file' && !this.data.opened) return;
    }
    const op: PendingOp = prior ?? { staffId: me.staff.id, kind: 'academy_complete', key: uuid(), path: `/academy/lessons/${id}/complete`, body: {}, at: Date.now(), label: '学完了', ref: id };
    this.setData({ busy: true, notice: '' });
    const out = await sendPending<AcademyCompletion>(op);
    this.setData({ busy: false });
    if (out.status === 'ok') {
      this.setData({ done: true, notice: completionText(out.data), noticeTone: 'success' });
      wx.vibrateShort({ type: 'light' });
      return;
    }
    if (out.status === 'signed_out') return toLogin();
    if (out.status === 'not_sent') return this.setData({ notice: SAVE_FAILED, noticeTone: 'error' });
    if (out.status === 'rejected') return this.setData({ notice: messageOf(out.error), noticeTone: 'error' });
    this.setData({ notice: out.status === 'unknown' && isOffline(out.error) ? `连不上门店系统。${UNSURE}` : UNSURE, noticeTone: 'warn' });
  },

  onNext() {
    if (this.data.nextId) wx.redirectTo({ url: `/pages/academy-lesson/index?id=${this.data.nextId}` });
  },

  /** 回到这门课：上一页就是这门课的就退回去，不然换成这门课（页面栈不越叠越深） */
  onCourse() {
    const pages = getCurrentPages();
    const prev = pages.length > 1 ? pages[pages.length - 2] : null;
    if (prev && prev.route === 'pages/academy-course/index' && Number((prev.options as Record<string, string>).id) === this.data.courseId) {
      wx.navigateBack();
      return;
    }
    wx.redirectTo({ url: `/pages/academy-course/index?id=${this.data.courseId}` });
  },
});
