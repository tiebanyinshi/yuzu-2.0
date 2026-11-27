// 汤崎学堂的学习算法（docs/ACADEMY.md 第 7 节）：FSRS 间隔复习、BKT 掌握度、测验按掌握度抽题。不要数据库，秒级。

import { describe, expect, it } from 'vitest';
import { bktUpdate, BKT, FSRS_GRADE_LABELS, FSRS_W, fsrsInterval, fsrsRetrievability, fsrsReview, MASTERY_STATUS_LABELS, masteryStatus } from '../src/shared/academy-algo';
import { pickQuestions } from '../src/server/modules/academy/assess';

describe('FSRS 每日一练', () => {
  it('过了 S 天还记得的概率是 0.9；目标保持率 0.9 时间隔就是 S 天（四舍五入，1–180 天）', () => {
    expect(fsrsRetrievability(10, 10)).toBeCloseTo(0.9, 10);
    expect(fsrsRetrievability(0, 3)).toBe(1);
    expect(fsrsInterval(15.69105)).toBe(16);
    expect(fsrsInterval(0.40255)).toBe(1);
    expect(fsrsInterval(5000)).toBe(180);
  });

  it('第一次：稳定度取 w0–w3，难度 D0 = w4 − e^(w5·(G−1)) + 1', () => {
    const good = fsrsReview(null, 3, 0);
    expect(good.stability).toBe(FSRS_W[2]);
    expect(good.difficulty).toBeCloseTo(FSRS_W[4] - Math.exp(FSRS_W[5] * 2) + 1, 10);
    expect(good.intervalDays).toBe(3);
    expect(fsrsReview(null, 1, 0)).toMatchObject({ stability: FSRS_W[0], difficulty: FSRS_W[4], intervalDays: 1 });
    expect(fsrsReview(null, 4, 0).intervalDays).toBe(16);
  });

  it('之后：按时复习记得的稳定度变大（很熟 > 记得 > 模糊）；忘了的稳定度不超过原来、难度变高；难度限在 1–10', () => {
    const card = fsrsReview(null, 3, 0);
    const hard = fsrsReview(card, 2, 3);
    const good = fsrsReview(card, 3, 3);
    const easy = fsrsReview(card, 4, 3);
    expect(good.stability).toBeGreaterThan(card.stability);
    expect(easy.stability).toBeGreaterThan(good.stability);
    expect(good.stability).toBeGreaterThan(hard.stability);
    const again = fsrsReview(card, 1, 3);
    expect(again.stability).toBeLessThanOrEqual(card.stability);
    expect(again.difficulty).toBeGreaterThan(card.difficulty);
    let d = card;
    for (let i = 0; i < 30; i += 1) d = fsrsReview(d, 1, 1);
    expect(d.difficulty).toBeLessThanOrEqual(10);
    let e = card;
    for (let i = 0; i < 30; i += 1) e = fsrsReview(e, 4, e.intervalDays);
    expect(e.difficulty).toBeGreaterThanOrEqual(1);
    expect(e.intervalDays).toBe(180);
    expect(FSRS_GRADE_LABELS[1]).toBe('忘了');
  });
});

describe('BKT 掌握度', () => {
  it('答对升、答错降，概率在 0–1；连续答对到「已掌握」，连续答错是「薄弱」', () => {
    const first = bktUpdate(null, true, 'single');
    expect(first).toBeGreaterThan(BKT.initial);
    expect(bktUpdate(null, false, 'single')).toBeLessThan(BKT.initial);
    let p: number | null = null;
    for (let i = 0; i < 6; i += 1) p = bktUpdate(p, true, 'single');
    expect(masteryStatus(p!)).toBe('mastered');
    let q: number | null = null;
    for (let i = 0; i < 3; i += 1) q = bktUpdate(q, false, 'single');
    expect(masteryStatus(q!)).toBe('weak');
    expect(MASTERY_STATUS_LABELS.learning).toBe('学习中');
    // 判断题猜对的概率高：答对一次升得少
    expect(bktUpdate(null, true, 'judge')).toBeLessThan(bktUpdate(null, true, 'single'));
  });
});

describe('测验按掌握度抽题', () => {
  it('薄弱的知识点先抽，知识点轮流抽，够数为止；题不够时全抽', () => {
    const pool = ['甲', '甲', '甲', '乙', '乙', '丙'].map((skill, id) => ({ id, skill }));
    const mastery = new Map([
      ['甲', 0.9],
      ['乙', 0.2],
      ['丙', 0.5],
    ]);
    const fixed = () => 0;
    const three = pickQuestions(pool, mastery, 3, fixed);
    expect(three.map((q) => q.skill).sort()).toEqual(['丙', '乙', '甲']);
    const two = pickQuestions(pool, mastery, 2, fixed);
    expect(two.map((q) => q.skill).sort()).toEqual(['丙', '乙']);
    expect(pickQuestions(pool, mastery, 50, Math.random)).toHaveLength(6);
  });
});
