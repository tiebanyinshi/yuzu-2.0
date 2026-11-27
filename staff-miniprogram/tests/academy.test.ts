// 学堂的纯函数（src/utils/academy.ts）：文字与学堂一字不差、块的样子、课中小测的作答、测验能不能交、首页与列表里一行写什么。

import { describe, expect, it } from 'vitest';
import { ACADEMY_CATEGORY_LABELS, ACADEMY_LESSON_KIND_LABELS, ACADEMY_LEVELS } from '../../src/shared/academy';
import { parseAcademyMarkup, splitBold } from '../../src/shared/academy-markup';
import {
  assignedRows,
  blockViews,
  CATEGORY_LABELS,
  completionText,
  courseRow,
  dailyAnswerLine,
  dailyLine,
  KIND_LABELS,
  lessonRow,
  LEVELS,
  levelView,
  optionViews,
  pathRow,
  questionState,
  quizReady,
  sameChoice,
  segs,
  toggleChoice,
  unansweredCount,
} from '../src/utils/academy';

describe('文字与学堂一样', () => {
  it('分类、课时种类、六级', () => {
    expect(CATEGORY_LABELS).toEqual(ACADEMY_CATEGORY_LABELS);
    expect(KIND_LABELS).toEqual(ACADEMY_LESSON_KIND_LABELS);
    expect(LEVELS).toEqual(ACADEMY_LEVELS);
  });

  it('加粗切段与学堂网页同一个结果', () => {
    for (const t of ['先**问候**再发牌', '**禁忌**', '没有加粗', '**甲**和**乙**', '']) expect(segs(t)).toEqual(splitBold(t));
  });
});

const ARTICLE = [
  '## 本课目标',
  '学完能说出泡汤的**三个**禁忌。',
  '',
  ':::ban 不宜泡汤',
  '- 酒后',
  '- 空腹',
  ':::',
  '',
  ':::check',
  '酒后能泡汤吗？',
  '- [ ] 能',
  '- [x] 不能',
  ':::',
  '',
  ':::question multi skill=禁忌',
  '哪些人不宜泡汤？',
  '- [x] 酒后的',
  '- [x] 空腹的',
  '- [ ] 刚运动完歇过的',
  ':::',
].join('\n');

describe('课件的块', () => {
  const views = blockViews(parseAcademyMarkup(ARTICLE).blocks);

  it('按学堂解析好的块画：正文切出加粗，提示块带标题，小测带作答的样子', () => {
    expect(views.map((v) => v.type)).toEqual(['heading', 'paragraph', 'callout', 'question', 'question']);
    const p = views[1]!;
    expect(p.type === 'paragraph' && p.segs.filter((g) => g.bold).map((g) => g.text)).toEqual(['三个']);
    const c = views[2]!;
    expect(c.type === 'callout' && [c.tone, c.title, c.lines.length]).toEqual(['ban', '不宜泡汤', 2]);
    const q = views[3]!;
    expect(q.type === 'question' && [q.check, q.q.multi, q.st.revealed, q.st.opts.length]).toEqual([true, false, false, 2]);
    const m = views[4]!;
    expect(m.type === 'question' && [m.check, m.q.multi]).toEqual([false, true]);
    expect(unansweredCount(views)).toBe(2);
  });

  it('课中小测：单选点了就亮答案（对错、标出对的）；多选选好了再对答案；都答过才能点「学完了」', () => {
    const q = views[3]!;
    if (q.type !== 'question') throw new Error('not a question');
    const wrong = questionState(q.q, toggleChoice([], 0, false), true);
    expect(wrong.correct).toBe(false);
    expect(wrong.opts.map((o) => [o.chosen, o.right, o.wrong])).toEqual([
      [true, false, true],
      [false, true, false],
    ]);
    expect(questionState(q.q, [1], true).correct).toBe(true);
    const m = views[4]!;
    if (m.type !== 'question') throw new Error('not a question');
    let chosen = toggleChoice([], 1, true);
    chosen = toggleChoice(chosen, 0, true);
    expect(chosen).toEqual([0, 1]);
    expect(questionState(m.q, chosen, false).opts.every((o) => !o.right && !o.wrong)).toBe(true);
    expect(questionState(m.q, chosen, true).correct).toBe(true);
    expect(toggleChoice(chosen, 1, true)).toEqual([0]);
    const answered = views.map((v) => (v.type === 'question' ? { ...v, st: questionState(v.q, [0], true) } : v));
    expect(unansweredCount(answered)).toBe(0);
  });

  it('翻牌卡、情景一开始都没翻、没选', () => {
    const src = [':::cards 记一记', '酒后 | 不宜泡汤', '空腹 | 先吃点东西', ':::', '', ':::scenario 客人喝了酒', '客人说想泡汤。', '- [x] 劝他先休息 | 好', '- [ ] 让他泡 | 不行', ':::'].join('\n');
    const v = blockViews(parseAcademyMarkup(src).blocks);
    expect(v.map((b) => b.type)).toEqual(['cards', 'scenario']);
    const cards = v[0]!;
    expect(cards.type === 'cards' && cards.cards.map((c) => c.flipped)).toEqual([false, false]);
    const sc = v[1]!;
    expect(sc.type === 'scenario' && sc.picked).toBe(-1);
  });
});

describe('作答', () => {
  it('单选换成点的那个；对不对不看先后', () => {
    expect(toggleChoice([2], 0, false)).toEqual([0]);
    expect(sameChoice([1, 0], [0, 1])).toBe(true);
    expect(sameChoice([0], [0, 1])).toBe(false);
  });

  it('测验每题都选了才能交', () => {
    const qs = [
      { id: 1, kind: 'single' as const, stem: 'a', options: ['x', 'y'] },
      { id: 2, kind: 'multi' as const, stem: 'b', options: ['x', 'y'] },
    ];
    expect(quizReady(qs, [[0], []])).toBe(false);
    expect(quizReady(qs, [[0], [0, 1]])).toBe(true);
    expect(quizReady([], [])).toBe(false);
  });

  it('选项的样子：没交只标选中，交了标出对的与选错的', () => {
    expect(optionViews(['甲', '乙'], [0], null)).toEqual([
      { text: '甲', chosen: true, right: false, wrong: false },
      { text: '乙', chosen: false, right: false, wrong: false },
    ]);
    expect(optionViews(['甲', '乙'], [0], [1]).map((o) => [o.right, o.wrong])).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  it('每日一练交了以后的一句', () => {
    expect(dailyAnswerLine({ correct: true, dueOn: '2026-12-01' }, '2026-11-27')).toBe('答对了 · 12 月 1 日再复习');
    expect(dailyAnswerLine({ correct: false, dueOn: '2026-11-27' }, '2026-11-27')).toBe('答错了 · 今天还会再出');
    expect(dailyAnswerLine({ correct: null, dueOn: '2026-11-30' }, '2026-11-27')).toBe('记下了 · 11 月 30 日再复习');
    expect(dailyLine({ doneToday: 3, target: 10, streak: 2 })).toBe('今天 3/10 · 连续 2 天');
    expect(dailyLine({ doneToday: 10, target: 10, streak: 0 })).toBe('今天做完了');
  });
});

describe('首页与列表', () => {
  it('等级：这一级走了几成、离下一级还差多少；满级', () => {
    const me = { credits: 105, level: ACADEMY_LEVELS[1]!, nextLevel: ACADEMY_LEVELS[2]!, monthSeconds: 1500 } as never;
    expect(levelView(me)).toEqual({ title: 'LV2 · 温汤渐暖', credits: '105 学分', next: '再 45 分升「汤中好手」', pct: 50, minutes: '本月学了 25 分钟' });
    const top = { credits: 900, level: ACADEMY_LEVELS[5]!, nextLevel: null, monthSeconds: 0 } as never;
    expect(levelView(top)).toMatchObject({ next: '已满级', pct: 100 });
  });

  it('必修：没学完的在前；截止与逾期写出来，学完的不写截止', () => {
    const rows = assignedRows([
      { kind: 'course', id: 1, title: '已学完的', cover: 'pine', required: true, dueOn: '2026-11-20', overdue: true, done: 3, total: 3, completed: true },
      { kind: 'path', id: 2, title: '前厅新员工地图', cover: 'pine', required: true, dueOn: '2026-11-25', overdue: true, done: 1, total: 4, completed: false },
      { kind: 'course', id: 3, title: '收银', cover: 'pine', required: true, dueOn: null, overdue: false, done: 0, total: 2, completed: false },
    ]);
    expect(rows.map((r) => [r.title, r.sub, r.overdue])).toEqual([
      ['前厅新员工地图', '学习地图 · 完成 1/4 · 11 月 25 日已过截止', true],
      ['收银', '课程 · 完成 0/2', false],
      ['已学完的', '课程 · 已学完', false],
    ]);
  });

  it('地图、课程、课时一行写什么', () => {
    expect(pathRow({ id: 1, title: '地图', courseCount: 3, doneCount: 3, credits: 5 } as never)).toMatchObject({ sub: '3 个阶段 · 已学完 · 5 学分', done: true });
    expect(courseRow({ id: 1, title: '泡汤安全', category: 'industry', lessonCount: 4, doneCount: 1, minutes: 20, credits: 5 } as never)).toEqual({
      id: 1,
      title: '泡汤安全',
      sub: '行业通识 · 4 节 · 约 20 分钟 · 5 学分',
      progress: '已学 1/4',
      done: false,
    });
    expect(lessonRow({ id: 9, seq: 2, title: '课后测验', kind: 'quiz', minutes: 5, credits: 2, state: 'done', quiz: { count: 5, pass: 80 } } as never)).toEqual({
      id: 9,
      title: '2. 课后测验',
      sub: '测验 · 每次 5 题、80 分及格 · 2 学分',
      state: '已完成',
      done: true,
    });
    expect(lessonRow({ id: 8, seq: 1, title: '三个禁忌', kind: 'article', minutes: 6, credits: 1, state: 'todo', quiz: null } as never).sub).toBe('图文课件 · 约 6 分钟 · 1 学分');
  });

  it('学完以后的一句：学分、课程与地图学完、升级；以前学完过的不再加分', () => {
    expect(
      completionText({ lessonId: 1, credits: 2, courseCompleted: true, pathsCompleted: [{ id: 1, title: '前厅新员工地图', credits: 5, certNo: 'C-001' }], levelUp: { level: 2, title: '温汤渐暖', min: 60 } }),
    ).toBe('+2 学分；这门课学完了；学完了「前厅新员工地图」，证书 C-001；升到 LV2「温汤渐暖」');
    expect(completionText({ lessonId: 1, credits: 0, courseCompleted: false, pathsCompleted: [], levelUp: null })).toBe('这一节以前学完过，不再加学分');
    expect(completionText(null)).toBe('');
  });
});
