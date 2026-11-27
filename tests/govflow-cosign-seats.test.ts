// 8.2.15 会签一级要几个不同的人坐满（docs/V8215_GF_CONFIG.md）：提交与「流程与阈值 → 试算」共用 approverProblems，
// 按「席位 → 能坐的人」求最大匹配，不只看候选人并集的人数；提交人回避照旧。纯规则，不连数据库。

import { describe, expect, it } from 'vitest';
import type { GfNode, SeatContext } from '../src/shared/govflow';
import { approverProblems, maxDistinctSeats } from '../src/server/modules/govflow/engine';

const A = 1;
const B = 2;
const C = 3;
const D = 4;
const ctx = (members: SeatContext['members'], submittedBy = 99): SeatContext => ({ members, deptHeadId: null, performerId: null, submittedBy, subjectStaffId: null });
const three: GfNode = { kind: 'all', roles: ['finance_reviewer', 'legal', 'hr'], label: '三方会签' };
const codes = (nodes: GfNode[], c: SeatContext) => approverProblems(nodes, c).map((p) => p.code);

describe('最大匹配', () => {
  it('并集够人但两席只能是同一个人：坐不满', () => {
    expect(maxDistinctSeats([[A], [A], [B, C]])).toBe(2);
  });
  it('要换人才坐得满的（增广路）：坐得满', () => {
    // 第一席先给 A，第二席只能 A：把第一席换成 B
    expect(maxDistinctSeats([[A, B], [A], [C]])).toBe(3);
    expect(maxDistinctSeats([[A, B, C], [A, B], [A]])).toBe(3);
  });
  it('有一席没人：少一席', () => {
    expect(maxDistinctSeats([[A], [], [B]])).toBe(2);
    expect(maxDistinctSeats([])).toBe(0);
  });
});

describe('会签一级的人够不够（提交、试算同一个检查）', () => {
  it('财务＝{甲}、法务＝{甲}、人事＝{乙、丙}：并集三人，照样报 GF_COSIGN_SAME', () => {
    expect(codes([three], ctx({ finance_reviewer: [A], legal: [A], hr: [B, C] }))).toEqual(['GF_COSIGN_SAME']);
  });
  it('财务＝{甲、乙}、法务＝{甲}、人事＝{丙}：换一下就坐得满，不报', () => {
    expect(codes([three], ctx({ finance_reviewer: [A, B], legal: [A], hr: [C] }))).toEqual([]);
  });
  it('提交人回避以后再算：乙自己提交，财务只剩甲、和法务撞上', () => {
    const m = { finance_reviewer: [A, B], legal: [A], hr: [C, D] };
    expect(codes([three], ctx(m))).toEqual([]);
    expect(codes([three], ctx(m, B))).toEqual(['GF_COSIGN_SAME']);
  });
  it('两角色会签照旧：两席同一人报，不同人不报', () => {
    const two: GfNode = { kind: 'all', roles: ['finance_chief', 'cfo'] };
    expect(codes([two], ctx({ finance_chief: [A], cfo: [A] }))).toEqual(['GF_COSIGN_SAME']);
    expect(codes([two], ctx({ finance_chief: [A], cfo: [B] }))).toEqual([]);
  });
});
