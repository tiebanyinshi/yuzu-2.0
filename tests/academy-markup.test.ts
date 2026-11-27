// 汤崎学堂（docs/ACADEMY.md 第 5、6 节）：课件文本的解析、等级与截止日的计算。不要数据库，秒级。

import { describe, expect, it } from 'vitest';
import {
  academyDueOn,
  academyLevelOf,
  ACADEMY_CATEGORIES,
  ACADEMY_CATEGORY_LABELS,
  ACADEMY_LESSON_KINDS,
  ACADEMY_LESSON_KIND_LABELS,
  ACADEMY_LEVELS,
  ACADEMY_STATUS_LABELS,
} from '../src/shared/academy';
import { academyPlainText, ACADEMY_QUESTION_KINDS, ACADEMY_QUESTION_KIND_LABELS, parseAcademyMarkup, splitBold } from '../src/shared/academy-markup';

const ok = (src: string) => {
  const r = parseAcademyMarkup(src);
  expect(r.problems).toEqual([]);
  return r.blocks;
};

describe('学堂课件文本', () => {
  it('正文：段落、小标题、列表、有序列表、引用；中文换行直接接，英文之间补空格', () => {
    const blocks = ok(['## 本课目标', '', '学完能**说清**泡汤的', '三个禁忌。', '', '- 酒后', '- 空腹', '1. 先冲淋', '2、再入池', '', '> 安全第一', 'Hot', 'spring'].join('\n'));
    expect(blocks).toEqual([
      { type: 'heading', text: '本课目标' },
      { type: 'paragraph', text: '学完能**说清**泡汤的三个禁忌。' },
      { type: 'list', ordered: false, items: ['酒后', '空腹'] },
      { type: 'list', ordered: true, items: ['先冲淋', '再入池'] },
      { type: 'quote', text: '安全第一' },
      { type: 'paragraph', text: 'Hot spring' },
    ]);
    expect(splitBold('学完能**说清**泡汤')).toEqual([
      { text: '学完能', bold: false },
      { text: '说清', bold: true },
      { text: '泡汤', bold: false },
    ]);
  });

  it('块：要点 / 注意 / 禁忌、步骤、记忆卡、表格、情景', () => {
    const blocks = ok(
      [
        ':::ban 这些人不宜泡汤',
        '- 酒后',
        '- 心脏病未控制',
        ':::',
        ':::steps 前台接待',
        '1. 问候｜三米微笑、十秒问候',
        '2. 发牌|核对人数',
        ':::',
        ':::cards 记一记',
        '干蒸｜温度高、湿度低',
        ':::',
        ':::table 水温',
        '池子｜温度',
        '热池｜38–42℃',
        ':::',
        ':::scenario 客人说头晕',
        '一位客人从热池出来说头晕。',
        '- [x] 扶到通风处坐下、补水、通知主管｜对：先离开高温环境',
        '- [ ] 让他再泡一会儿｜不对：会更严重',
        ':::',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual(['callout', 'steps', 'cards', 'table', 'scenario']);
    expect(blocks[0]).toMatchObject({
      tone: 'ban',
      title: '这些人不宜泡汤',
      lines: [
        { text: '酒后', bullet: true },
        { text: '心脏病未控制', bullet: true },
      ],
    });
    expect(blocks[1]).toMatchObject({
      steps: [
        { title: '问候', detail: '三米微笑、十秒问候' },
        { title: '发牌', detail: '核对人数' },
      ],
    });
    expect(blocks[3]).toMatchObject({ head: ['池子', '温度'], rows: [['热池', '38–42℃']] });
    expect(blocks[4]).toMatchObject({ situation: '一位客人从热池出来说头晕。', options: [{ best: true }, { best: false }] });
  });

  it('题：课中小测按对的个数认单选 / 多选；判断题写「答案：」；题库题要题型与知识点；问答卡要「答：」', () => {
    const blocks = ok(
      [
        ':::check',
        '酒后能马上泡汤吗？',
        '- [ ] 能',
        '- [x] 不能',
        '解析：酒后血管扩张，容易晕厥。',
        ':::',
        ':::check',
        '哪些人不宜泡汤？',
        '- [x] 酒后的人',
        '- [x] 孕妇（未经医生同意）',
        '- [ ] 刚冲淋过的人',
        ':::',
        ':::question judge skill=泡汤安全 level=2',
        '泡汤一次越久越好。',
        '答案：错',
        '解析：一次 10–15 分钟为宜。',
        ':::',
        ':::question recall skill=手牌',
        '客人丢了手牌怎么办？',
        '答：先安抚，核对身份后挂失补牌，',
        '按门店规定收赔偿。',
        ':::',
      ].join('\n'),
    );
    expect(blocks.map((b) => (b.type === 'check' || b.type === 'question' ? `${b.type}:${b.question.kind}` : b.type))).toEqual(['check:single', 'check:multi', 'question:judge', 'question:recall']);
    const judge = blocks[2]!.type === 'question' ? blocks[2]!.question : null;
    expect(judge).toMatchObject({ skill: '泡汤安全', level: 2, options: ['对', '错'], answer: [1] });
    const recall = blocks[3]!.type === 'question' ? blocks[3]!.question : null;
    expect(recall).toMatchObject({ answerText: '先安抚，核对身份后挂失补牌，按门店规定收赔偿。', options: [], level: 1 });
    expect(academyPlainText(blocks)).toContain('酒后血管扩张');
  });

  it('写错的块报出行号，不进结果', () => {
    const { blocks, problems } = parseAcademyMarkup(
      ['开头一段', ':::question single', '没写知识点', '- [x] 甲', '- [x] 乙', ':::', ':::huh', ':::', ':::scenario', '情景', '- [ ] 只有一个｜反馈', ':::', ':::', ':::cards', '只有正面'].join('\n'),
    );
    expect(blocks).toEqual([{ type: 'paragraph', text: '开头一段' }]);
    expect(problems.map((p) => p.line)).toEqual([2, 2, 7, 9, 9, 13, 14, 15]);
    expect(problems.map((p) => p.message).join('；')).toMatch(/知识点.*单选题要有且只有一个.*不认识.*至少两个选项.*最好的做法.*多了一行.*没有结束.*正面｜背面/);
  });
});

describe('学堂等级与截止日', () => {
  it('每个分类、状态、课时类型、题型都有中文名', () => {
    expect(ACADEMY_CATEGORIES.map((c) => ACADEMY_CATEGORY_LABELS[c])).toEqual(['汤崎之道', '应知应会', '行业通识', '岗位技能', '系统小课堂', '安全', '管理']);
    expect(Object.values(ACADEMY_STATUS_LABELS)).toEqual(['草稿', '已上架', '已下架']);
    expect(ACADEMY_LESSON_KINDS.every((k) => ACADEMY_LESSON_KIND_LABELS[k])).toBe(true);
    expect(ACADEMY_QUESTION_KINDS.map((k) => ACADEMY_QUESTION_KIND_LABELS[k])).toEqual(['单选', '多选', '判断', '问答卡']);
  });

  it('等级按学分门槛（XT05），满级没有下一级', () => {
    expect(academyLevelOf(0)).toEqual({ current: ACADEMY_LEVELS[0], next: ACADEMY_LEVELS[1] });
    expect(academyLevelOf(59).current.level).toBe(1);
    expect(academyLevelOf(60).current).toMatchObject({ level: 2, title: '温汤渐暖' });
    expect(academyLevelOf(5000)).toEqual({ current: ACADEMY_LEVELS[5], next: null });
  });

  it('截止日 = max(指派生效日, 入职日) + 天数；没设天数为空', () => {
    expect(academyDueOn('2026-11-01', null, 30)).toBe('2026-12-01');
    expect(academyDueOn('2026-11-01', '2026-11-20', 30)).toBe('2026-12-20');
    expect(academyDueOn('2026-11-01', '2026-01-01', 7)).toBe('2026-11-08');
    expect(academyDueOn('2026-11-01', null, null)).toBeNull();
  });
});
