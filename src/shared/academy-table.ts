// 学堂 · 从表格导入题（docs/ACADEMY.md 第 5 节，PENDING_DECISIONS XT12）：门店现有的「应知应会」Excel / CSV 直接导进题库。
//   · 表头认这些名字（不分大小写、去掉空格）：题型、知识点、题干 / 题目 / 问题、选项A–选项F（或 A–F）、答案 / 正确答案、解析、难度；
//   · 只有「问题、答案」两列的导成问答卡（每日一练里自己评记没记住）；有选项的按答案的字母个数认单选 / 多选；答案是对 / 错的认判断；
//   · 页面先在本机解析、预览（标出哪一行哪里不对），服务端用同一份再核对一遍。

import { academyQuestionProblems, type AcademyQuestionDraft, type AcademyQuestionKind } from './academy-markup';

/** 一次最多导多少行 */
export const ACADEMY_TABLE_MAX_ROWS = 500;
/** 一道题最多几个选项（A–F，与题库的题一致） */
const ACADEMY_TABLE_MAX_OPTIONS = 6;

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const HEADERS: Record<'kind' | 'skill' | 'stem' | 'answer' | 'explanation' | 'level', string[]> = {
  kind: ['题型', '类型'],
  skill: ['知识点', '分类', '模块'],
  stem: ['题干', '题目', '问题'],
  answer: ['答案', '正确答案', '参考答案'],
  explanation: ['解析', '说明'],
  level: ['难度', '等级'],
};
const KIND_WORDS: Record<string, AcademyQuestionKind> = {
  单选: 'single',
  单选题: 'single',
  single: 'single',
  多选: 'multi',
  多选题: 'multi',
  multi: 'multi',
  判断: 'judge',
  判断题: 'judge',
  judge: 'judge',
  问答: 'recall',
  问答题: 'recall',
  问答卡: 'recall',
  简答: 'recall',
  recall: 'recall',
};
const TRUE_WORDS = ['对', '正确', '√', '✓', 't', 'true', '是'];
const FALSE_WORDS = ['错', '错误', '×', '✗', 'f', 'false', '否'];

export interface AcademyTableResult {
  questions: AcademyQuestionDraft[];
  /** 行号按表格里的行（表头是第 1 行） */
  problems: { row: number; message: string }[];
}

/** 解析一张表（第一行是表头）；defaultSkill 用在没有「知识点」列或这一格空着的时候 */
export function parseQuestionTable(rows: readonly (readonly string[])[], defaultSkill: string): AcademyTableResult {
  const problems: AcademyTableResult['problems'] = [];
  const questions: AcademyQuestionDraft[] = [];
  const [head, ...body] = rows;
  if (!head) return { questions, problems: [{ row: 1, message: '表格是空的' }] };
  const col = (names: string[]) => head.findIndex((h) => names.some((n) => norm(h) === norm(n)));
  const at = {
    kind: col(HEADERS.kind),
    skill: col(HEADERS.skill),
    stem: col(HEADERS.stem),
    answer: col(HEADERS.answer),
    explanation: col(HEADERS.explanation),
    level: col(HEADERS.level),
  };
  const optionCols: { letter: number; index: number }[] = [];
  head.forEach((h, index) => {
    const m = /^(?:选项)?([a-z])$/i.exec(h.replace(/\s+/g, ''));
    if (m) optionCols.push({ letter: m[1]!.toUpperCase().charCodeAt(0) - 65, index });
  });
  optionCols.sort((a, b) => a.letter - b.letter);
  // 一道题最多 6 个选项（A–F）：多出来的列不悄悄丢掉，整张表拒绝（Codex 审查 bb22802）
  const tooMany = optionCols.find((o) => o.letter >= ACADEMY_TABLE_MAX_OPTIONS);
  if (tooMany) return { questions, problems: [{ row: 1, message: `一道题最多 ${ACADEMY_TABLE_MAX_OPTIONS} 个选项（A–F），表里有选项${String.fromCharCode(65 + tooMany.letter)}` }] };
  if (at.stem < 0) return { questions, problems: [{ row: 1, message: '没找到「题干」（或「题目」「问题」）这一列' }] };
  if (at.answer < 0) return { questions, problems: [{ row: 1, message: '没找到「答案」这一列' }] };
  if (body.length > ACADEMY_TABLE_MAX_ROWS) problems.push({ row: 1, message: `一次最多导 ${ACADEMY_TABLE_MAX_ROWS} 行，分几次导` });
  body.slice(0, ACADEMY_TABLE_MAX_ROWS).forEach((cells, i) => {
    const row = i + 2;
    const cell = (k: number) => (k >= 0 ? (cells[k] ?? '').trim() : '');
    const stem = cell(at.stem);
    const answerRaw = cell(at.answer);
    if (!stem && !answerRaw && cells.every((c) => !c.trim())) return;
    // 选项按字母放（A 是第 0 个）：中间空着一格不能往前挤，挤了答案字母就对不上了（Codex 审查 a69d88e）
    const byLetter: string[] = [];
    for (const o of optionCols) byLetter[o.letter] = cell(o.index);
    const last = byLetter.reduce((acc, v, k) => (v ? k : acc), -1);
    const options = Array.from({ length: last + 1 }, (_, k) => byLetter[k] ?? '');
    const blank = options.findIndex((o) => !o);
    if (blank >= 0) {
      problems.push({ row, message: `选项要从 A 开始连着填：选项${String.fromCharCode(65 + blank)}空着，后面的选项却有内容` });
      return;
    }
    const declared = KIND_WORDS[norm(cell(at.kind))];
    const answerWord = norm(answerRaw);
    let kind: AcademyQuestionKind;
    if (declared) kind = declared;
    else if (options.length) kind = answerWord.replace(/[^a-z]/g, '').length > 1 ? 'multi' : 'single';
    else if (TRUE_WORDS.includes(answerWord) || FALSE_WORDS.includes(answerWord)) kind = 'judge';
    else kind = 'recall';
    let answer: number[] = [];
    let answerText = '';
    let opts = options;
    if (kind === 'recall') {
      answerText = answerRaw;
      opts = [];
    } else if (kind === 'judge') {
      opts = ['对', '错'];
      if (TRUE_WORDS.includes(answerWord)) answer = [0];
      else if (FALSE_WORDS.includes(answerWord)) answer = [1];
      else {
        problems.push({ row, message: '判断题的答案写「对」或「错」' });
        return;
      }
    } else {
      // 答案里的字母一个都不丢：超出选项的（包括 G 以后的）整行拒绝，不悄悄改成别的答案
      answer = [...new Set(answerWord.replace(/[^a-z]/g, '').split(''))].map((ch) => ch.charCodeAt(0) - 97).sort((a, b) => a - b);
      if (!answer.length) {
        problems.push({ row, message: '选择题的答案写选项字母（如 A 或 AC）' });
        return;
      }
      const missing = answer.find((k) => k >= options.length);
      if (missing !== undefined) {
        problems.push({ row, message: `答案里的 ${String.fromCharCode(65 + missing)} 没有对应的选项` });
        return;
      }
    }
    const levelRaw = cell(at.level);
    const level = (['3', '难'].includes(levelRaw) ? 3 : ['2', '中'].includes(levelRaw) ? 2 : 1) as 1 | 2 | 3;
    const q: AcademyQuestionDraft = {
      kind,
      skill: (cell(at.skill) || defaultSkill).slice(0, 30),
      level,
      stem,
      options: opts,
      answer,
      answerText,
      explanation: cell(at.explanation),
    };
    const p = academyQuestionProblems(q);
    if (p.length) problems.push(...p.map((message) => ({ row, message })));
    else questions.push(q);
  });
  if (!questions.length && !problems.length) problems.push({ row: 2, message: '表格里没有题' });
  return { questions, problems };
}
