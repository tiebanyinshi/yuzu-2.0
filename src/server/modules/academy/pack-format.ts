// 学堂内置课件包的课程文件（docs/ACADEMY.md 第 6 节）：一门课一个 Markdown 文件——头部写课程信息，然后按课时分段，最后是题库。
//
//   ---
//   code: spa-103
//   title: 泡汤健康与安全禁忌
//   category: industry
//   department:            （可空：org_departments.key）
//   cover: lake
//   sort: 30
//   summary: 一句话
//   ---
//   # 课时 key=intro min=6：标题          图文课件（正文是学堂课件文本）
//   # 测验 key=quiz count=5 pass=80：标题 测验（正文留空）
//   # 实操 key=practice：标题              实操签核（正文每行一个检查项「- …」）
//   # 题库                                 后面只放 :::question 块
//
// 解析只看格式与内容是否合规（课件文本用 parseAcademyMarkup），不碰数据库。

import { createHash } from 'node:crypto';
import { ACADEMY_CATEGORIES, ACADEMY_COVERS, ACADEMY_DEFAULT_CREDITS, ACADEMY_QUIZ_DEFAULT, type AcademyCategory, type AcademyCover } from '@shared/academy';
import { parseAcademyMarkup, type AcademyQuestionDraft } from '@shared/academy-markup';

export interface PackLesson {
  key: string;
  kind: 'article' | 'quiz' | 'practical';
  title: string;
  minutes: number;
  credits: number;
  body: string;
  quizCount: number | null;
  quizPass: number | null;
}

export interface PackCourse {
  code: string;
  title: string;
  category: AcademyCategory;
  departmentKey: string | null;
  cover: AcademyCover;
  sort: number;
  summary: string;
  lessons: PackLesson[];
  /** 题库题：key 是「课程编号-题号」，导入时用它对上已导入的题 */
  questions: (AcademyQuestionDraft & { key: string })[];
  /** 整份文件内容的 SHA-256（导入时记下，本地没改过才能用新版覆盖） */
  hash: string;
}

export interface PackProblem {
  line: number;
  message: string;
}

const KINDS: Record<string, PackLesson['kind']> = { 课时: 'article', 测验: 'quiz', 实操: 'practical' };
const CODE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function parseCourseFile(src: string): { course: PackCourse | null; problems: PackProblem[] } {
  const text = src.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const problems: PackProblem[] = [];
  const problem = (line: number, message: string) => problems.push({ line, message });
  if (lines[0]?.trim() !== '---') return { course: null, problems: [{ line: 1, message: '第一行要是「---」（课程信息开头）' }] };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { course: null, problems: [{ line: 1, message: '课程信息没有结束的「---」' }] };
  const meta: Record<string, string> = {};
  for (let i = 1; i < end; i += 1) {
    const m = /^([a-z]+):\s*(.*)$/.exec(lines[i]!.trim());
    if (!m) {
      if (lines[i]!.trim()) problem(i + 1, '课程信息一行写「名字: 值」');
      continue;
    }
    meta[m[1]!] = m[2]!.trim();
  }
  const code = meta.code ?? '';
  if (!CODE_RE.test(code)) problem(1, 'code 只能是小写字母、数字、短横线（2–40 个）');
  if (!meta.title || meta.title.length > 60) problem(1, 'title 要 1–60 个字');
  if (!(ACADEMY_CATEGORIES as readonly string[]).includes(meta.category ?? '')) problem(1, `category 只能是 ${ACADEMY_CATEGORIES.join(' / ')}`);
  const cover = (meta.cover || 'pine') as AcademyCover;
  if (!(ACADEMY_COVERS as readonly string[]).includes(cover)) problem(1, `cover 只能是 ${ACADEMY_COVERS.join(' / ')}`);
  if ((meta.summary ?? '').length > 300) problem(1, 'summary 最多 300 个字');
  const department = meta.department || null;
  if (department && !/^[a-z]+$/.test(department)) problem(1, 'department 是部门的英文键（如 front）');

  const lessons: PackLesson[] = [];
  const questions: PackCourse['questions'] = [];
  let sawBank = false;
  let current: { kind: PackLesson['kind'] | 'bank'; header: number; title: string; attrs: Record<string, string>; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.body.join('\n').replace(/^\n+|\n+$/g, '');
    if (current.kind === 'bank') {
      const parsed = parseAcademyMarkup(body);
      for (const p of parsed.problems) problem(current.header + p.line, `题库：${p.message}`);
      for (const b of parsed.blocks) {
        if (b.type !== 'question') {
          problem(current.header, '题库里只放 :::question 块');
          continue;
        }
        questions.push({ ...b.question, key: `${code}-${questions.length + 1}` });
      }
    } else {
      const a = current.attrs;
      const kind = current.kind;
      const key = a.key ?? '';
      if (!KEY_RE.test(key)) problem(current.header, '课时要写 key=小写字母数字短横线');
      if (lessons.some((l) => l.key === key)) problem(current.header, `课时 key=${key} 重复`);
      if (!current.title || current.title.length > 60) problem(current.header, '课时标题要 1–60 个字');
      if (kind === 'article') {
        const parsed = parseAcademyMarkup(body);
        for (const p of parsed.problems) problem(current.header + p.line, p.message);
        if (!body.trim()) problem(current.header, '图文课时是空的');
        if (body.length > 60000) problem(current.header, '课时太长');
      }
      if (kind === 'practical') {
        const items = body.split('\n').filter((l) => l.trim());
        if (!items.length || items.length > 30) problem(current.header, '实操检查项要 1–30 条');
        for (const it of items) if (!/^\s*-\s+\S/.test(it) || it.length > 84) problem(current.header, `实操检查项写「- …」且不超过 80 个字：${it}`);
      }
      if (kind === 'quiz' && body.trim()) problem(current.header, '测验课时不写正文（题从题库里抽）');
      const num = (v: string | undefined, def: number, min: number, max: number) => {
        if (v === undefined) return def;
        const n = Number(v);
        if (!Number.isInteger(n) || n < min || n > max) {
          problem(current!.header, `数字 ${v} 不在 ${min}–${max} 之间`);
          return def;
        }
        return n;
      };
      lessons.push({
        key,
        kind,
        title: current.title,
        minutes: num(a.min, 5, 1, 240),
        credits: num(a.credits, ACADEMY_DEFAULT_CREDITS[kind], 0, 20),
        body: kind === 'quiz' ? '' : kind === 'practical' ? body.replace(/^\s*-\s+/gm, '') : body,
        quizCount: kind === 'quiz' ? num(a.count, ACADEMY_QUIZ_DEFAULT.count, 1, 50) : null,
        quizPass: kind === 'quiz' ? num(a.pass, ACADEMY_QUIZ_DEFAULT.pass, 1, 100) : null,
      });
    }
    current = null;
  };
  for (let i = end + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const head = /^#\s+(课时|测验|实操|题库)\s*([^：:]*?)\s*(?:[：:]\s*(.*))?$/.exec(line.trim());
    if (head && line.startsWith('# ')) {
      flush();
      const attrs: Record<string, string> = {};
      for (const tok of (head[2] ?? '').split(/\s+/).filter(Boolean)) {
        const eq = tok.indexOf('=');
        if (eq > 0) attrs[tok.slice(0, eq)] = tok.slice(eq + 1);
        else problem(i + 1, `「${tok}」看不懂（写成 名字=值）`);
      }
      if (head[1] === '题库') {
        if (sawBank) problem(i + 1, '题库只能有一段');
        sawBank = true;
        current = { kind: 'bank', header: i + 1, title: '', attrs, body: [] };
      } else current = { kind: KINDS[head[1]!]!, header: i + 1, title: (head[3] ?? '').trim(), attrs, body: [] };
      continue;
    }
    if (!current) {
      if (line.trim()) problem(i + 1, '正文要写在「# 课时 …」下面');
      continue;
    }
    current.body.push(line);
  }
  flush();
  if (!lessons.length) problem(end + 1, '一门课至少一个课时');
  const quizzes = lessons.filter((l) => l.kind === 'quiz');
  for (const q of quizzes) if (questions.length < (q.quizCount ?? 0)) problem(end + 1, `题库只有 ${questions.length} 题，不够测验每次抽 ${q.quizCount} 题`);
  if (problems.length) return { course: null, problems };
  return {
    course: {
      code,
      title: meta.title!,
      category: meta.category as AcademyCategory,
      departmentKey: department,
      cover,
      sort: Number(meta.sort ?? 100) || 100,
      summary: meta.summary ?? '',
      lessons,
      questions,
      hash: createHash('sha256').update(text).digest('hex'),
    },
    problems,
  };
}
