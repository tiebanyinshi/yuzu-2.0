// 汤崎学堂的两个学习算法（docs/ACADEMY.md 第 7 节）：只借鉴公开的公式与参数，不引用任何开源项目的代码。
//
//   · 每日一练：FSRS 间隔复习（open-spaced-repetition，Anki 在用）。每人每题一张卡，记「稳定度 S（天）」与「难度 D（1–10）」；
//     可提取概率 R(t,S) = (1 + F·t/S)^C，F = 19/81、C = −0.5（t = S 时 R = 0.9）；目标保持率 0.9 时下次间隔 = S 天。
//     参数取公开的默认值 w0–w16（不含同一天内的短期复习项）。
//   · 掌握度：贝叶斯知识追踪 BKT（OATutor / pyBKT 用的经典模型）。每人每个知识点一个「掌握了的概率」，每次作答按贝叶斯公式更新，再加上「这次学会」的概率。

import type { AcademyQuestionKind } from './academy-markup';

/** FSRS 公开默认参数 w0–w16 */
export const FSRS_W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898] as const;
const F = 19 / 81;
const C = -0.5;
/** 目标保持率（XT07） */
export const FSRS_RETENTION = 0.9;
/** 间隔上下限（天） */
export const FSRS_MIN_DAYS = 1;
export const FSRS_MAX_DAYS = 180;

/** 1 忘了 / 2 模糊 / 3 记得 / 4 很熟 */
export type FsrsGrade = 1 | 2 | 3 | 4;
export const FSRS_GRADE_LABELS: Record<FsrsGrade, string> = { 1: '忘了', 2: '模糊', 3: '记得', 4: '很熟' };

export interface FsrsState {
  stability: number;
  difficulty: number;
}

const w = (i: number) => FSRS_W[i]!;
const clampD = (d: number) => Math.min(10, Math.max(1, d));

/** 过了 elapsedDays 天、稳定度 stability 时还记得的概率 */
export function fsrsRetrievability(elapsedDays: number, stability: number): number {
  return (1 + (F * Math.max(0, elapsedDays)) / stability) ** C;
}

/** 稳定度 → 下次间隔（天，四舍五入，限在 1–180） */
export function fsrsInterval(stability: number, retention = FSRS_RETENTION): number {
  const raw = (stability / F) * (retention ** (1 / C) - 1);
  return Math.min(FSRS_MAX_DAYS, Math.max(FSRS_MIN_DAYS, Math.round(raw)));
}

const initialDifficulty = (g: FsrsGrade) => clampD(w(4) - Math.exp(w(5) * (g - 1)) + 1);

/**
 * 复习一次以后的新状态：card 为空是第一次（新题）。稳定度用复习前的难度算，难度之后再更新（与 FSRS 的做法一致）。
 * 返回新的稳定度、难度与下次间隔（天）。
 */
export function fsrsReview(card: FsrsState | null, grade: FsrsGrade, elapsedDays: number): FsrsState & { intervalDays: number } {
  if (!card) {
    const stability = w(grade - 1);
    return { stability, difficulty: initialDifficulty(grade), intervalDays: fsrsInterval(stability) };
  }
  const { stability: s, difficulty: d } = card;
  const r = fsrsRetrievability(elapsedDays, s);
  let stability: number;
  if (grade === 1) {
    const forgot = w(11) * d ** -w(12) * ((s + 1) ** w(13) - 1) * Math.exp(w(14) * (1 - r));
    stability = Math.min(s, forgot);
  } else {
    const hard = grade === 2 ? w(15) : 1;
    const easy = grade === 4 ? w(16) : 1;
    stability = s * (1 + Math.exp(w(8)) * (11 - d) * s ** -w(9) * (Math.exp(w(10) * (1 - r)) - 1) * hard * easy);
  }
  stability = Math.max(0.01, stability);
  const damped = d - (w(6) * (grade - 3) * (10 - d)) / 9;
  const difficulty = clampD(w(7) * initialDifficulty(4) + (1 - w(7)) * damped);
  return { stability, difficulty, intervalDays: fsrsInterval(stability) };
}

/** BKT 参数（待确认 XT 第 7.1 节）：初始掌握、学会、失误；猜对按题型 */
export const BKT = { initial: 0.3, learn: 0.15, slip: 0.1 } as const;
export const BKT_GUESS: Record<AcademyQuestionKind, number> = { single: 0.2, multi: 0.1, judge: 0.4, recall: 0.05 };
/** ≥ 0.95 已掌握、< 0.6 薄弱 */
export const MASTERY_DONE = 0.95;
export const MASTERY_WEAK = 0.6;

/** 作答一次以后掌握了的概率；prev 为空用初始值 */
export function bktUpdate(prev: number | null, correct: boolean, kind: AcademyQuestionKind): number {
  const p = prev ?? BKT.initial;
  const g = BKT_GUESS[kind];
  const s = BKT.slip;
  const posterior = correct ? (p * (1 - s)) / (p * (1 - s) + (1 - p) * g) : (p * s) / (p * s + (1 - p) * (1 - g));
  return Math.min(1, Math.max(0, posterior + (1 - posterior) * BKT.learn));
}

export type MasteryStatus = 'mastered' | 'learning' | 'weak';
export const MASTERY_STATUS_LABELS: Record<MasteryStatus, string> = { mastered: '已掌握', learning: '学习中', weak: '薄弱' };
export const masteryStatus = (p: number): MasteryStatus => (p >= MASTERY_DONE ? 'mastered' : p < MASTERY_WEAK ? 'weak' : 'learning');
