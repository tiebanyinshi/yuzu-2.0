// 学堂课件文本（店主 2026-11-27，docs/ACADEMY.md 第 6 节）：扩展的 Markdown，内置课件包与后台编辑共用这一份解析，页面按解析出的块渲染。
//   正文：空行分段，**加粗**，「- 」列表，「1. 」有序列表，「## 」小标题，「> 」引用；
//   块：「:::名字 参数」开头、单独一行「:::」结束——tip / warn / ban（要点、注意、禁忌）、steps、cards、table、scenario、check、question。
// 参照 Adapt Learning 的「块—组件」与 H5P 的翻牌卡、分支情景（只借鉴做法，不引用它们的代码）。

export type AcademyQuestionKind = 'single' | 'multi' | 'judge' | 'recall';
export const ACADEMY_QUESTION_KINDS: readonly AcademyQuestionKind[] = ['single', 'multi', 'judge', 'recall'];
export const ACADEMY_QUESTION_KIND_LABELS: Record<AcademyQuestionKind, string> = { single: '单选', multi: '多选', judge: '判断', recall: '问答卡' };

/** 题目（课中小测、题库共用）：recall 问答卡没有选项，答案写在 answerText，作答时自己评记没记住 */
export interface AcademyQuestionDraft {
  kind: AcademyQuestionKind;
  /** 知识点（掌握度按它算）；课中小测可以不写 */
  skill: string;
  /** 难度：1 记住、2 理解、3 应用（布鲁姆分类的三档） */
  level: 1 | 2 | 3;
  stem: string;
  options: string[];
  /** 对的选项（从 0 起） */
  answer: number[];
  answerText: string;
  explanation: string;
}

export type AcademyCalloutTone = 'tip' | 'warn' | 'ban';

export type AcademyBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'callout'; tone: AcademyCalloutTone; title: string; lines: { text: string; bullet: boolean }[] }
  | { type: 'steps'; title: string; steps: { title: string; detail: string }[] }
  | { type: 'cards'; title: string; cards: { front: string; back: string }[] }
  | { type: 'table'; title: string; head: string[]; rows: string[][] }
  | { type: 'scenario'; title: string; situation: string; options: { text: string; feedback: string; best: boolean }[] }
  | { type: 'check'; question: AcademyQuestionDraft }
  | { type: 'question'; question: AcademyQuestionDraft };

export interface AcademyMarkupProblem {
  /** 从 1 起的行号 */
  line: number;
  message: string;
}

/** 上限：一节课最多 300 块，题干 300 字、选项 120 字、解析 500 字，一个选项题 2–6 个选项 */
export const ACADEMY_MARKUP_MAX_BLOCKS = 300;
export const ACADEMY_STEM_MAX = 300;
export const ACADEMY_OPTION_MAX = 120;
export const ACADEMY_EXPLANATION_MAX = 500;
export const ACADEMY_SKILL_MAX = 30;

const BLOCK_NAMES = ['tip', 'warn', 'ban', 'steps', 'cards', 'table', 'scenario', 'check', 'question'] as const;
type BlockName = (typeof BLOCK_NAMES)[number];

/** 「｜」或「|」分列（全角、半角都认） */
const cells = (line: string) => line.split(/[｜|]/).map((c) => c.trim());
const OPTION_RE = /^[-*]\s*\[( |x|X|√|✓)\]\s*(.*)$/;
const ORDERED_RE = /^\d{1,2}[.、．)]\s*(.*)$/;

/** 两行接成一段：中文直接接，两边都是英文字母或数字时加一个空格 */
function joinLines(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    out = out && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(line) ? `${out} ${line}` : out + line;
  }
  return out;
}

/** 正文里的 **加粗**：切成一段段（页面渲染与提取纯文字用） */
export function splitBold(text: string): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1]!, bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, '$1');

/** 参数：「single skill=泡汤安全 level=2」→ { _: ['single'], skill: '泡汤安全', level: '2' } */
function parseArgs(raw: string): { words: string[]; named: Record<string, string> } {
  const words: string[] = [];
  const named: Record<string, string> = {};
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf('=');
    if (eq > 0) named[token.slice(0, eq)] = token.slice(eq + 1);
    else words.push(token);
  }
  return { words, named };
}

/** 一道题的正文：题干、「- [x] / - [ ]」选项、「答：」问答卡答案、「答案：对 / 错」、「解析：」 */
function parseQuestion(
  body: { text: string; line: number }[],
  args: { words: string[]; named: Record<string, string> },
  inline: boolean,
  startLine: number,
  problems: AcademyMarkupProblem[],
): AcademyQuestionDraft | null {
  const before = problems.length;
  const problem = (message: string, line = startLine) => problems.push({ line, message });
  const stem: string[] = [];
  const options: string[] = [];
  const answer: number[] = [];
  const answerText: string[] = [];
  const explanation: string[] = [];
  let mode: 'stem' | 'options' | 'answer' | 'explanation' = 'stem';
  let judgeAnswer: boolean | null = null;
  for (const { text, line } of body) {
    const t = text.trim();
    const opt = OPTION_RE.exec(t);
    if (opt) {
      if (mode === 'explanation' || mode === 'answer') problem('选项要写在「答：」「解析：」前面', line);
      mode = 'options';
      if (opt[1] !== ' ') answer.push(options.length);
      options.push(opt[2]!.trim());
      continue;
    }
    const judge = /^答案[:：]\s*(对|错|正确|错误|√|×)\s*$/.exec(t);
    if (judge) {
      judgeAnswer = ['对', '正确', '√'].includes(judge[1]!);
      mode = 'answer';
      continue;
    }
    const ans = /^答[:：]\s*(.*)$/.exec(t);
    if (ans) {
      mode = 'answer';
      if (ans[1]) answerText.push(ans[1]);
      continue;
    }
    const exp = /^解析[:：]\s*(.*)$/.exec(t);
    if (exp) {
      mode = 'explanation';
      if (exp[1]) explanation.push(exp[1]);
      continue;
    }
    if (mode === 'stem') stem.push(t);
    else if (mode === 'answer') answerText.push(t);
    else if (mode === 'explanation') explanation.push(t);
    else if (t) problem('选项之间不能夹别的文字（每个选项一行「- [x] …」或「- [ ] …」）', line);
  }
  const named = args.named;
  const declared = args.words[0];
  let kind: AcademyQuestionKind;
  if (declared && (ACADEMY_QUESTION_KINDS as readonly string[]).includes(declared)) kind = declared as AcademyQuestionKind;
  else if (declared) {
    problem(`题型「${declared}」不认识（single 单选 / multi 多选 / judge 判断 / recall 问答卡）`);
    return null;
  } else if (inline) kind = judgeAnswer !== null ? 'judge' : answer.length > 1 ? 'multi' : 'single';
  else {
    problem('题库题要写题型：:::question single / multi / judge / recall');
    return null;
  }
  if (kind === 'judge' && !options.length && judgeAnswer !== null) {
    options.push('对', '错');
    answer.push(judgeAnswer ? 0 : 1);
  }
  const q: AcademyQuestionDraft = {
    kind,
    skill: (named.skill ?? '').trim(),
    level: named.level === '3' ? 3 : named.level === '2' ? 2 : 1,
    stem: joinLines(stem),
    options,
    answer,
    answerText: joinLines(answerText),
    explanation: joinLines(explanation),
  };
  if (named.level && !['1', '2', '3'].includes(named.level)) problem('level 只能是 1、2、3');
  for (const message of academyQuestionProblems(q, inline)) problem(message);
  return problems.length > before ? null : q;
}

/** 一道题哪里不合规（后台手写的题与课件文本里的题共用）；inline 是课中小测（可以不写知识点） */
export function academyQuestionProblems(q: AcademyQuestionDraft, inline = false): string[] {
  const out: string[] = [];
  const { kind, options, answer } = q;
  if (!q.stem) out.push('缺题干');
  if (q.stem.length > ACADEMY_STEM_MAX) out.push(`题干最多 ${ACADEMY_STEM_MAX} 个字`);
  if (q.explanation.length > ACADEMY_EXPLANATION_MAX) out.push(`解析最多 ${ACADEMY_EXPLANATION_MAX} 个字`);
  if (q.skill.length > ACADEMY_SKILL_MAX) out.push(`知识点最多 ${ACADEMY_SKILL_MAX} 个字`);
  if (!inline && !q.skill) out.push('题库题要写知识点：skill=…');
  if (kind === 'recall') {
    if (options.length) out.push('问答卡不写选项，答案写在「答：」后面');
    if (!q.answerText) out.push('问答卡缺「答：」');
    if (q.answerText.length > ACADEMY_EXPLANATION_MAX) out.push(`答案最多 ${ACADEMY_EXPLANATION_MAX} 个字`);
    return out;
  }
  if (options.length < 2 || options.length > 6) out.push('选项要 2–6 个');
  if (options.some((o) => !o)) out.push('有空的选项');
  if (options.some((o) => o.length > ACADEMY_OPTION_MAX)) out.push(`一个选项最多 ${ACADEMY_OPTION_MAX} 个字`);
  if (new Set(options).size !== options.length) out.push('选项有重复');
  if (answer.some((a) => !Number.isInteger(a) || a < 0 || a >= options.length) || new Set(answer).size !== answer.length) out.push('答案不在选项里');
  if (kind === 'single' && answer.length !== 1) out.push('单选题要有且只有一个对的选项（- [x]）');
  if (kind === 'multi' && answer.length < 2) out.push('多选题至少两个对的选项（只有一个对的写成单选）');
  if (kind === 'judge' && (options.length !== 2 || answer.length !== 1)) out.push('判断题写「答案：对」或「答案：错」');
  return out;
}

interface RawBlock {
  name: BlockName;
  args: string;
  line: number;
  body: { text: string; line: number }[];
}

function buildBlock(raw: RawBlock, problems: AcademyMarkupProblem[]): AcademyBlock | null {
  const lines = raw.body.filter((l) => l.text.trim());
  const title = raw.args.trim();
  const problem = (message: string, line = raw.line) => problems.push({ line, message });
  switch (raw.name) {
    case 'tip':
    case 'warn':
    case 'ban': {
      if (!lines.length) problem('要点 / 注意 / 禁忌块是空的');
      return {
        type: 'callout',
        tone: raw.name,
        title,
        lines: lines.map(({ text }) => {
          const m = /^\s*[-*]\s+(.*)$/.exec(text);
          return m ? { text: m[1]!.trim(), bullet: true } : { text: text.trim(), bullet: false };
        }),
      };
    }
    case 'steps': {
      const steps = lines.map(({ text }) => {
        const t = text.trim().replace(/^(?:\d{1,2}[.、．)]|[-*])\s*/, '');
        const [head = '', ...rest] = cells(t);
        return { title: head, detail: rest.join('｜') };
      });
      if (!steps.length) problem('步骤块是空的');
      steps.forEach((s, i) => !s.title && problem('有一步没写名字', lines[i]!.line));
      return { type: 'steps', title, steps };
    }
    case 'cards': {
      const cards = lines.map(({ text, line }) => {
        const [front = '', ...rest] = cells(text);
        const back = rest.join('｜');
        if (!front || !back) problem('记忆卡每行写「正面｜背面」', line);
        return { front, back };
      });
      if (!cards.length) problem('记忆卡块是空的');
      return { type: 'cards', title, cards };
    }
    case 'table': {
      const [head, ...rest] = lines.map((l) => cells(l.text));
      if (!head) {
        problem('表格是空的');
        return null;
      }
      const rows = rest.map((r, i) => {
        if (r.length !== head.length) problem(`这一行有 ${r.length} 列，表头是 ${head.length} 列`, lines[i + 1]!.line);
        return head.map((_, c) => r[c] ?? '');
      });
      return { type: 'table', title, head, rows };
    }
    case 'scenario': {
      const situation: string[] = [];
      const options: { text: string; feedback: string; best: boolean }[] = [];
      for (const { text, line } of raw.body) {
        const opt = OPTION_RE.exec(text.trim());
        if (opt) {
          const [t = '', ...fb] = cells(opt[2]!);
          options.push({ text: t, feedback: fb.join('｜'), best: opt[1] !== ' ' });
          if (!t || !fb.join('').trim()) problem('情景的选项写「- [x] 做法｜点了以后的反馈」', line);
        } else if (options.length && text.trim()) problem('情景的选项后面不能再写情景', line);
        else situation.push(text);
      }
      if (options.length < 2) problem('情景至少两个选项');
      if (!options.some((o) => o.best)) problem('情景要标出最好的做法（- [x]）');
      return { type: 'scenario', title, situation: joinLines(situation), options };
    }
    case 'check':
    case 'question': {
      const q = parseQuestion(raw.body, parseArgs(raw.args), raw.name === 'check', raw.line, problems);
      return q ? { type: raw.name, question: q } : null;
    }
  }
}

/** 解析一节课的课件文本；有问题的块不进结果，问题带行号 */
export function parseAcademyMarkup(src: string): { blocks: AcademyBlock[]; problems: AcademyMarkupProblem[] } {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: AcademyBlock[] = [];
  const problems: AcademyMarkupProblem[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: joinLines(para) });
    para = [];
    if (list) blocks.push({ type: 'list', ...list });
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const t = line.trim();
    const open = /^:::\s*([a-z]+)\s*(.*)$/.exec(t);
    if (open) {
      flush();
      const name = open[1] as BlockName;
      const start = i + 1;
      const body: { text: string; line: number }[] = [];
      let closed = false;
      for (i += 1; i < lines.length; i += 1) {
        if (lines[i]!.trim() === ':::') {
          closed = true;
          break;
        }
        body.push({ text: lines[i]!, line: i + 1 });
      }
      if (!closed) problems.push({ line: start, message: `「:::${open[1]}」没有结束（单独一行「:::」）` });
      if (!(BLOCK_NAMES as readonly string[]).includes(name)) {
        problems.push({ line: start, message: `「:::${open[1]}」不认识（可用：${BLOCK_NAMES.join('、')}）` });
        continue;
      }
      const before = problems.length;
      const block = buildBlock({ name, args: open[2] ?? '', line: start, body }, problems);
      if (block && problems.length === before) blocks.push(block);
      continue;
    }
    if (t === ':::') {
      problems.push({ line: i + 1, message: '多了一行「:::」（前面没有对应的开头）' });
      continue;
    }
    if (!t) {
      flush();
      continue;
    }
    const heading = /^#{2,4}\s+(.*)$/.exec(t);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', text: heading[1]!.trim() });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(t);
    if (quote) {
      flush();
      blocks.push({ type: 'quote', text: quote[1]!.trim() });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(t);
    const ordered = bullet ? null : ORDERED_RE.exec(t);
    if (bullet || ordered) {
      if (para.length) {
        blocks.push({ type: 'paragraph', text: joinLines(para) });
        para = [];
      }
      const isOrdered = !!ordered;
      if (list && list.ordered !== isOrdered) flush();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push((bullet ?? ordered)![1]!.trim());
      continue;
    }
    if (list) flush();
    para.push(t);
  }
  flush();
  if (blocks.length > ACADEMY_MARKUP_MAX_BLOCKS) problems.push({ line: 1, message: `一节课最多 ${ACADEMY_MARKUP_MAX_BLOCKS} 块，拆成几节课` });
  return { blocks, problems };
}

/** 课件的纯文字（检索、AI 出题与问柚子用）：小测与题库题只取题干与解析 */
export function academyPlainText(blocks: readonly AcademyBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
      case 'paragraph':
      case 'quote':
        out.push(plain(b.text));
        break;
      case 'list':
        out.push(...b.items.map(plain));
        break;
      case 'callout':
        out.push(b.title, ...b.lines.map((l) => plain(l.text)));
        break;
      case 'steps':
        out.push(b.title, ...b.steps.map((s) => `${s.title}：${s.detail}`));
        break;
      case 'cards':
        out.push(b.title, ...b.cards.map((c) => `${c.front}：${c.back}`));
        break;
      case 'table':
        out.push(b.title, b.head.join(' '), ...b.rows.map((r) => r.join(' ')));
        break;
      case 'scenario':
        out.push(b.title, b.situation, ...b.options.filter((o) => o.best).map((o) => `${o.text}：${o.feedback}`));
        break;
      case 'check':
      case 'question':
        out.push(b.question.stem, b.question.answerText, b.question.explanation);
        break;
    }
  }
  return out.filter(Boolean).join('\n');
}
