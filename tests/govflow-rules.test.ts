// 业财法审批流 P01 的纯规则（不连数据库）：排链（履约执行人 +1、内控、回避上移）、谁能坐哪一席、状态机、工作日、
// 通用事项的金额档位（1 / 5 / 30 万卡整值前后一分钱）、知会名单去重。

import { describe, expect, it } from 'vitest';
import {
  COSIGN_FINANCE_CFO,
  addWorkdays,
  ccTargets,
  ccUrgent,
  deriveStatus,
  generalTemplate,
  nodeLabel,
  planFlow,
  seatsFor,
  type GfNode,
  type PlanContext,
  type StatusFacts,
} from '../src/shared/govflow';

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  members: { finance_reviewer: [11], legal: [12], finance_chief: [13], cfo: [14], entity_head: [15], chairman: [16], internal_control: [17], performer: [18, 1] },
  deptHeadId: 1,
  performerId: 18,
  submittedBy: 2,
  subjectStaffId: null,
  flags: [],
  ...over,
});
const labels = (nodes: GfNode[]) => nodes.map(nodeLabel);
const finalOf = (cents: number, flags: string[] = []) => {
  const t = generalTemplate({ amountCents: cents, contractLike: false, flags });
  return labels(t.filter((n) => n.stage === 'final'));
};

describe('通用事项的金额档位（不含税，整值前后一分钱）', () => {
  it('1 万：9,999.99 财总终审，10,000.00 起 CFO', () => {
    expect(finalOf(999_999)).toEqual(['财总']);
    expect(finalOf(1_000_000)).toEqual(['CFO']);
    expect(finalOf(1_000_001)).toEqual(['CFO']);
  });
  it('5 万：49,999.99 CFO 终审，50,000.00 起 CEO 终审（CFO 先审）', () => {
    expect(finalOf(4_999_999)).toEqual(['CFO']);
    expect(labels(generalTemplate({ amountCents: 5_000_000, contractLike: false, flags: [] })).slice(-2)).toEqual(['CFO', 'CEO']);
    expect(finalOf(5_000_001)).toEqual(['CEO']);
  });
  it('30 万：299,999.99 CEO 终审，300,000.00 起 CEO → 董事长', () => {
    expect(finalOf(29_999_999)).toEqual(['CEO']);
    expect(labels(generalTemplate({ amountCents: 30_000_000, contractLike: false, flags: [] })).slice(-2)).toEqual(['CEO', '董事长']);
    expect(finalOf(30_000_001)).toEqual(['董事长']);
  });
  it('重大风险 / 预付款 / 超预算至少 CFO', () => {
    expect(finalOf(100_00, ['prepay'])).toEqual(['CFO']);
    expect(finalOf(100_00, ['major_risk'])).toEqual(['CFO']);
    expect(finalOf(100_00, ['over_budget'])).toEqual(['CFO']);
  });
  it('30 万的合同类事项是 5 级：部门负责人 → 履约执行人 → 财法分审 → CEO → 董事长（不压成 3 级）', () => {
    const plan = planFlow(generalTemplate({ amountCents: 30_000_000, contractLike: true, flags: [] }), ctx());
    expect(labels(plan.nodes)).toEqual(['部门负责人', '内部履约执行人', '财务、法务分别审核', 'CEO', '董事长']);
  });
});

describe('排链：履约执行人 +1（场景 43）、内控（场景 47）、回避（场景 12）', () => {
  const contract = generalTemplate({ amountCents: 2_000_000, contractLike: true, flags: [] });
  it('履约执行人插在部门负责人之后、财法之前', () => {
    expect(labels(planFlow(contract, ctx()).nodes).slice(0, 3)).toEqual(['部门负责人', '内部履约执行人', '财务、法务分别审核']);
  });
  it('履约执行人与部门负责人同一人时不重复', () => {
    const plan = planFlow(contract, ctx({ performerId: 1 }));
    expect(labels(plan.nodes)).not.toContain('内部履约执行人');
    expect(plan.notes.join()).toContain('同一人');
  });
  it('新供应商 / 招标 / 单一来源 / 核心品类 / 价格异常加内控，放在终审前；常规业务不加', () => {
    for (const flag of ['tender', 'single_source', 'new_supplier', 'core_category', 'price_abnormal']) {
      const nodes = labels(planFlow(generalTemplate({ amountCents: 500_000, contractLike: false, flags: [flag] }), ctx({ flags: [flag] })).nodes);
      expect(nodes.slice(-2)).toEqual(['内控', '财总']);
    }
    expect(labels(planFlow(generalTemplate({ amountCents: 500_000, contractLike: false, flags: [] }), ctx()).nodes)).not.toContain('内控');
  });
  it('终审人是提交人、角色里没别人：上移一级（财总 → CFO）', () => {
    const plan = planFlow(generalTemplate({ amountCents: 500_000, contractLike: false, flags: [] }), ctx({ submittedBy: 13 }));
    expect(labels(plan.nodes).at(-1)).toBe('CFO');
    expect(plan.notes.join()).toContain('回避');
  });
  it('终审人是事项本人也回避；角色里有别人的保留节点，只是本人不能审', () => {
    const plan = planFlow(generalTemplate({ amountCents: 2_000_000, contractLike: false, flags: [] }), ctx({ subjectStaffId: 14 }));
    expect(labels(plan.nodes).at(-1)).toBe('CEO');
    const two = ctx({ subjectStaffId: 14, members: { ...ctx().members, cfo: [14, 24] } });
    const kept = planFlow(generalTemplate({ amountCents: 2_000_000, contractLike: false, flags: [] }), two);
    expect(labels(kept.nodes).at(-1)).toBe('CFO');
    const final = kept.nodes.at(-1)!;
    expect(seatsFor(final, 14, { ...two, submittedBy: 2 })).toEqual([]);
    expect(seatsFor(final, 24, { ...two, submittedBy: 2 })).toEqual(['cfo']);
  });
  it('会签（财总＋CFO）里财总回避：换成上一级、仍是两个不同的角色', () => {
    const plan = planFlow([COSIGN_FINANCE_CFO], ctx({ submittedBy: 13 }));
    expect(plan.nodes[0]).toMatchObject({ kind: 'all', roles: ['entity_head', 'cfo'] });
  });
  it('董事长本人的事项、没有别的董事长：保留并提示配一位授权人', () => {
    const plan = planFlow(generalTemplate({ amountCents: 30_000_000, contractLike: false, flags: [] }), ctx({ submittedBy: 16 }));
    expect(labels(plan.nodes).at(-1)).toBe('董事长');
    expect(plan.notes.join()).toContain('没有别的授权人');
  });
});

describe('状态机（从真实单据算）', () => {
  const base: StatusFacts = {
    flow: null,
    withdrawn: false,
    execStarted: false,
    completed: false,
    archived: false,
    specialUnfilled: false,
    backfillOpen: false,
    dueOn: null,
    today: '2026-11-26',
  };
  it.each([
    [{}, 'draft'],
    [{ flow: 'pending' }, 'reviewing'],
    [{ flow: 'approved' }, 'to_execute'],
    [{ flow: 'approved', execStarted: true }, 'executing'],
    [{ flow: 'approved', completed: true }, 'completed'],
    [{ flow: 'approved', completed: true, archived: true }, 'archived'],
    [{ flow: 'returned' }, 'returned'],
    [{ flow: 'rejected' }, 'rejected'],
    [{ flow: 'cancelled', withdrawn: true }, 'withdrawn'],
    [{ flow: 'approved', specialUnfilled: true }, 'special_backfill'],
    [{ flow: 'approved', completed: true, backfillOpen: true }, 'backfill_pending'],
  ] as const)('%j → %s', (facts, status) => {
    expect(deriveStatus({ ...base, ...facts }).status).toBe(status);
  });
  it('过了期限还没完成的算逾期；完成的不算', () => {
    expect(deriveStatus({ ...base, flow: 'approved', dueOn: '2026-11-25' }).overdue).toBe(true);
    expect(deriveStatus({ ...base, flow: 'approved', dueOn: '2026-11-26' }).overdue).toBe(false);
    expect(deriveStatus({ ...base, flow: 'approved', completed: true, dueOn: '2026-11-25' }).overdue).toBe(false);
  });
});

describe('工作日', () => {
  it('周五确认的 1 个工作日是下周一；节假日跳过、调休上班算', () => {
    expect(addWorkdays('2026-11-27', 1)).toBe('2026-11-30');
    expect(addWorkdays('2026-11-26', 1)).toBe('2026-11-27');
    expect(addWorkdays('2026-11-26', 1, new Map([['2026-11-27', 'holiday']]))).toBe('2026-11-30');
    expect(addWorkdays('2026-11-27', 1, new Map([['2026-11-28', 'workday']]))).toBe('2026-11-28');
    expect(addWorkdays('2026-11-26', 5)).toBe('2026-12-03');
  });
});

describe('知会', () => {
  it('已参与审批的、提交人、重复的人不知会', () => {
    const out = ccTargets(
      [
        { staffId: 1, role: 'chairman' },
        { staffId: 2, role: 'cfo' },
        { staffId: 3, role: 'finance_chief' },
        { staffId: 1, role: 'business_gm' },
      ],
      new Set([2]),
      3,
    );
    expect(out).toEqual([{ staffId: 1, role: 'chairman' }]);
  });
  it('即时提醒：≥ 5 万、异常、紧急、重大风险、特批；其余进日报', () => {
    expect(ccUrgent(4_999_999, [], false)).toBe(false);
    expect(ccUrgent(5_000_000, [], false)).toBe(true);
    expect(ccUrgent(100, ['abnormal'], false)).toBe(true);
    expect(ccUrgent(100, [], true)).toBe(true);
    expect(ccUrgent(null, [], false)).toBe(false);
  });
});
