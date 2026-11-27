// 汤崎学堂的内置课件包（docs/ACADEMY.md 第 6 节，PENDING_DECISIONS XT11）：每一份都能解析、结构够、守住内容红线；表格导入题的解析。不要数据库。

import { describe, expect, it } from 'vitest';
import { ACADEMY_PACK_STATE_LABELS } from '../src/shared/academy';
import { parseQuestionTable } from '../src/shared/academy-table';
import { loadPacks } from '../src/server/modules/academy/packs';

const packs = loadPacks();

describe('学堂内置课件包', () => {
  it('17 门课都能解析；八张地图引用的课都在；每门课有测验、题够抽，题库三档难度都有', () => {
    expect(packs.courses).toHaveLength(17);
    expect(Object.values(ACADEMY_PACK_STATE_LABELS)).toEqual(['还没导入', '已导入', '有新内容', '本地改过']);
    expect(packs.paths.map((p) => p.code)).toEqual(['new-hire', 'front-growth', 'bath-growth', 'wellness-growth', 'dining-growth', 'safety-annual', 'lead-growth', 'spa-general']);
    for (const c of packs.courses) {
      const quiz = c.lessons.find((l) => l.kind === 'quiz');
      expect(quiz, c.code).toBeTruthy();
      expect(c.questions.filter((q) => q.kind !== 'recall').length, c.code).toBeGreaterThanOrEqual(quiz!.quizCount!);
      expect(c.lessons.filter((l) => l.kind === 'article').length, c.code).toBeGreaterThanOrEqual(3);
      expect(new Set(c.questions.map((q) => q.level)).size, c.code).toBe(3);
      if (c.category === 'must_know') expect(c.questions.filter((q) => q.kind === 'recall').length, c.code).toBeGreaterThanOrEqual(4);
    }
  });

  it('内容红线：不写价格、手机号；不写别家品牌；「沽清」不写错；不承诺疗效', () => {
    const all = packs.courses
      .map((c) => [c.title, c.summary, ...c.lessons.map((l) => l.body), ...c.questions.map((q) => [q.stem, ...q.options, q.answerText, q.explanation].join('\n'))].join('\n'))
      .join('\n');
    expect(all).not.toMatch(/\d+(\.\d+)?\s*元/);
    expect(all).not.toMatch(/1[3-9]\d{9}/);
    expect(all).not.toMatch(/希尔顿|欢朋|Hilton|Hampton/i);
    // 「沽清」的错写（check:code 第 4 条不许源码里出现那两个字，这里用编码写）
    expect(all).not.toContain('\u4f30清');
    // 疗效：课文里不出现（题库的错误选项、「禁忌」卡里的反例会写到，用来教「不能这样说」）
    const lessons = packs.courses.flatMap((c) => c.lessons.map((l) => l.body.replace(/:::ban[\s\S]*?\n:::/g, ''))).join('\n');
    expect(lessons).not.toMatch(/治愈|根治|包治/);
  });
});

describe('表格导入题', () => {
  it('认表头；有选项的按答案字母认单选 / 多选，对错认判断，只有问答两列的导成问答卡；不对的标出行号', () => {
    const rows = [
      ['题型', '知识点', '题干', '选项A', '选项B', '选项C', '答案', '解析', '难度'],
      ['', '接待', '见到客人先做什么？', '微笑问候', '低头玩手机', '', 'A', '先问候', '1'],
      ['', '接待', '哪些是接待要做的？', '问候', '核对人数', '玩手机', 'A、B', '', '中'],
      ['', '安全', '酒后可以马上泡汤。', '', '', '', '错', '', '难'],
      ['', '', '客人丢了手牌怎么办？', '', '', '', '先安抚，核对后挂失补牌', '', ''],
      ['', '接待', '少了答案的单选', '甲', '乙', '', '', '', ''],
      ['', '', '', '', '', '', '', '', ''],
    ];
    const { questions, problems } = parseQuestionTable(rows, '前厅接待');
    expect(questions.map((q) => q.kind)).toEqual(['single', 'multi', 'judge', 'recall']);
    expect(questions[1]).toMatchObject({ answer: [0, 1], level: 2 });
    expect(questions[2]).toMatchObject({ options: ['对', '错'], answer: [1], level: 3 });
    expect(questions[3]).toMatchObject({ skill: '前厅接待', answerText: '先安抚，核对后挂失补牌', options: [] });
    expect(problems).toEqual([{ row: 6, message: '选择题的答案写选项字母（如 A 或 AC）' }]);
    expect(parseQuestionTable([['问题', '答案']], 'x').problems[0]!.message).toBe('表格里没有题');
    expect(parseQuestionTable([['名字', '电话']], 'x').problems[0]!.message).toContain('题干');
  });
});
