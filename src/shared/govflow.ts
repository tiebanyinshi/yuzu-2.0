// 业财法审批流（店主 2026-11-26《业财法审批流开发批次拆分与执行说明-从零梳理版》，设计见 docs/APPROVAL_V4.md）。
// 第 P01 批：审批引擎与角色底座——角色映射（店主配置，不拿「店主」顶替）、4 级及以上审批链、会签（财总＋CFO 两人都同意）、
// 并行分审（财务、法务各出结论）、内部履约执行人 +1、内控参与节点、CC 知会、终审人回避、微信特批补登、通用流程状态。
// 这里只放两端共用的类型与纯函数（审批链怎么排、谁回避、状态怎么算），数据库与接口在 server/modules/govflow。

/** 角色（店主在「业财法 → 角色映射」里把真实账号配进来；最高角色是董事长，全系统只用这一个称谓） */
export const GF_ROLES = [
  'finance_reviewer',
  'finance_chief',
  'cfo',
  'legal',
  'entity_head',
  'chairman',
  'business_gm',
  'supply_chain_head',
  'seal_keeper',
  'cashier',
  'performer',
  'internal_control',
  'hr',
] as const;
export type GfRole = (typeof GF_ROLES)[number];
export const GF_ROLE_LABELS: Record<GfRole, string> = {
  finance_reviewer: '财务审核人',
  finance_chief: '财总',
  cfo: 'CFO',
  legal: '法务',
  entity_head: '经营主体负责人（CEO）',
  chairman: '董事长',
  business_gm: '业态总经理',
  supply_chain_head: '供应链负责人',
  seal_keeper: '章证管理员',
  cashier: '出纳',
  performer: '内部履约执行人',
  internal_control: '内控',
  hr: '人力资源',
};
/** 角色在审批链里显示的短名 */
export const GF_ROLE_SHORT: Record<GfRole, string> = { ...GF_ROLE_LABELS, entity_head: 'CEO' };

/** 回避时往上一级找（终审人、特批人不能批自己的事项）：财总 → CFO → 经营主体负责人 → 董事长 */
export const GF_ESCALATION: readonly GfRole[] = ['finance_reviewer', 'finance_chief', 'cfo', 'entity_head', 'chairman'];

/** 审批链的一个节点 */
export type GfNode =
  /** 费用承担部门的负责人（部门资料里的负责人） */
  | { kind: 'dept_head'; stage?: GfStage }
  /** 单据上指定的内部履约执行人（合同类，部门负责人之后、财法之前自动 +1） */
  | { kind: 'performer'; stage?: GfStage }
  /** 某个角色里任意一人同意 */
  | { kind: 'role'; role: GfRole; stage?: GfStage }
  /**
   * 几个角色各由不同的人同意、全部同意才过，任一人不同意即不通过：会签（财总＋CFO）与并行分审（财务、法务分别出结论）。
   * label 写在审批链上（例如「财总＋CFO 会签」）
   */
  | { kind: 'all'; roles: GfRole[]; label?: string; stage?: GfStage };

/** 节点的性质：review 审核；final 金额 / 风险终审；special 特批（终审、特批两种适用回避） */
export type GfStage = 'review' | 'final' | 'special';

export const GF_MAX_NODES = 12;

export function nodeLabel(node: GfNode): string {
  switch (node.kind) {
    case 'dept_head':
      return '部门负责人';
    case 'performer':
      return '内部履约执行人';
    case 'role':
      return GF_ROLE_SHORT[node.role];
    case 'all':
      return node.label ?? `${node.roles.map((r) => GF_ROLE_SHORT[r]).join('＋')}（${node.roles.length > 1 ? '共同审批' : '审批'}）`;
  }
}

/** 节点里要谁出结论：dept_head、performer 各一席；role 一席；all 每个角色一席 */
export function seatsOf(node: GfNode): (GfRole | 'dept_head' | 'performer')[] {
  return node.kind === 'all' ? [...node.roles] : node.kind === 'role' ? [node.role] : [node.kind];
}

/** 内控必须参与的情形（P01-07，场景 47）；常规库内业务不加签 */
export const GF_CONTROL_FLAGS = ['tender', 'single_source', 'new_supplier', 'core_category', 'price_abnormal'] as const;
export type GfControlFlag = (typeof GF_CONTROL_FLAGS)[number];
export const GF_CONTROL_FLAG_LABELS: Record<GfControlFlag, string> = {
  tender: '招标',
  single_source: '单一来源',
  new_supplier: '新供应商',
  core_category: '核心品类',
  price_abnormal: '价格异常',
};
/** 其他标记：大额 / 异常 / 特批让知会即时提醒，否则进日报 */
export const GF_OTHER_FLAGS = ['urgent', 'abnormal', 'major_risk', 'prepay', 'over_budget'] as const;
export const GF_FLAGS = [...GF_CONTROL_FLAGS, ...GF_OTHER_FLAGS] as const;
export type GfFlag = (typeof GF_FLAGS)[number];
export const GF_FLAG_LABELS: Record<GfFlag, string> = {
  ...GF_CONTROL_FLAG_LABELS,
  urgent: '紧急',
  abnormal: '异常',
  major_risk: '重大风险',
  prepay: '预付款',
  over_budget: '超预算',
};
export const needsInternalControl = (flags: readonly string[]) => flags.some((f) => (GF_CONTROL_FLAGS as readonly string[]).includes(f));

// ───────────────────────── 排审批链 ─────────────────────────

export interface PlanContext {
  /** 各角色现在映射的账号（已按单据的经营主体筛过） */
  members: Partial<Record<GfRole, readonly number[]>>;
  /** 费用承担部门的负责人 */
  deptHeadId: number | null;
  /** 单据指定的内部履约执行人 */
  performerId: number | null;
  /** 提交人 */
  submittedBy: number;
  /** 事项是谁的（报销人、收款员工……）：终审、特批也要回避 */
  subjectStaffId: number | null;
  flags: readonly string[];
}

export interface PlannedFlow {
  nodes: GfNode[];
  /** 排链时做了什么调整（写在审批单上给人看）：履约执行人与负责人同一人不重复、内控加签、回避上移 */
  notes: string[];
}

/** 回避的人：提交人与事项本人 */
export const recusedOf = (ctx: Pick<PlanContext, 'submittedBy' | 'subjectStaffId'>) => new Set([ctx.submittedBy, ...(ctx.subjectStaffId ? [ctx.subjectStaffId] : [])]);

/** 这个角色里除了回避的人还有没有人 */
const hasOther = (ctx: PlanContext, role: GfRole, recused: Set<number>) => (ctx.members[role] ?? []).some((id) => !recused.has(id));

/** 回避上移：从 role 往上找第一个有非回避的人、且不在 taken 里的角色；找不到返回 null（交给更高一级的其他授权人，见 escalateTop） */
export function escalate(ctx: PlanContext, role: GfRole, recused: Set<number>, taken: ReadonlySet<GfRole> = new Set()): GfRole | null {
  const start = GF_ESCALATION.indexOf(role);
  const chain = start < 0 ? [role, ...GF_ESCALATION.slice(GF_ESCALATION.indexOf('cfo'))] : GF_ESCALATION.slice(start);
  for (const r of chain) if (!taken.has(r) && hasOther(ctx, r, recused)) return r;
  return null;
}

/**
 * 按模板排出这张单的审批链（纯函数，P01-01/05/06/07）：
 *   · 履约执行人 +1：模板里有 performer 节点的（合同类），履约执行人与部门负责人是同一人时不重复（场景 43）；
 *   · 内控：单据带了招标 / 单一来源 / 新供应商 / 核心品类 / 价格异常的，在终审前加一级内控（场景 47），模板里已有的不重复；
 *   · 回避：终审、特批节点里的角色，提交人或事项本人是这个角色、且这个角色没有别人时，上移一级（场景 12）；
 *     有别人的保留节点，审批时只让别人审（engine 里 eligible 排除回避的人）。
 *   · 连着两级一样的合成一级；最多 GF_MAX_NODES 级。
 */
export function planFlow(template: readonly GfNode[], ctx: PlanContext): PlannedFlow {
  const notes: string[] = [];
  const recused = recusedOf(ctx);
  let nodes: GfNode[] = [];
  for (const node of template) {
    if (node.kind === 'performer') {
      if (ctx.performerId === null) {
        notes.push('没有指定内部履约执行人：这一级要先在单据上选人');
      } else if (ctx.performerId === ctx.deptHeadId && template.some((n) => n.kind === 'dept_head')) {
        notes.push('内部履约执行人与部门负责人是同一人，不重复审批');
        continue;
      }
    }
    nodes.push(node);
  }
  // 内控参与节点：放在第一个终审 / 特批节点前面
  if (needsInternalControl(ctx.flags) && !nodes.some((n) => seatsOf(n).includes('internal_control'))) {
    const at = nodes.findIndex((n) => n.stage === 'final' || n.stage === 'special');
    const ic: GfNode = { kind: 'role', role: 'internal_control', stage: 'review' };
    if (at < 0) nodes.push(ic);
    else nodes.splice(at, 0, ic);
    const why = GF_CONTROL_FLAGS.filter((f) => ctx.flags.includes(f)).map((f) => GF_CONTROL_FLAG_LABELS[f]);
    notes.push(`${why.join('、')}：加内控参与`);
  }
  // 回避
  nodes = nodes.map((node) => {
    if (node.stage !== 'final' && node.stage !== 'special') return node;
    if (node.kind === 'role') {
      if (hasOther(ctx, node.role, recused) || !(ctx.members[node.role] ?? []).some((id) => recused.has(id))) return node;
      const up = escalate(ctx, node.role, recused, new Set([node.role]));
      if (!up) {
        notes.push(`${GF_ROLE_SHORT[node.role]}是本人的事项、没有别的授权人：要店主在角色映射里加一位${GF_ROLE_SHORT[node.role]}`);
        return node;
      }
      notes.push(`${GF_ROLE_SHORT[node.role]}回避（本人的事项），改由${GF_ROLE_SHORT[up]}审批`);
      return { ...node, role: up };
    }
    if (node.kind === 'all') {
      const taken = new Set<GfRole>(node.roles);
      const roles = node.roles.map((r) => {
        if (hasOther(ctx, r, recused) || !(ctx.members[r] ?? []).some((id) => recused.has(id))) return r;
        const up = escalate(ctx, r, recused, taken);
        if (!up) {
          notes.push(`${GF_ROLE_SHORT[r]}是本人的事项、没有别的授权人：要店主在角色映射里加一位${GF_ROLE_SHORT[r]}`);
          return r;
        }
        taken.add(up);
        notes.push(`${GF_ROLE_SHORT[r]}回避（本人的事项），改由${GF_ROLE_SHORT[up]}共同审批`);
        return up;
      });
      return { ...node, roles };
    }
    return node;
  });
  // 连着两级完全一样的合成一级
  nodes = nodes.filter((n, i) => i === 0 || JSON.stringify(n) !== JSON.stringify(nodes[i - 1]));
  return { nodes: nodes.slice(0, GF_MAX_NODES), notes };
}

// ───────────────────────── 谁能审 ─────────────────────────

export interface SeatContext {
  members: Partial<Record<GfRole, readonly number[]>>;
  deptHeadId: number | null;
  performerId: number | null;
  submittedBy: number;
  subjectStaffId: number | null;
}

/**
 * 这个人能坐哪几席（同一节点里一个人只坐一席：会签要两个人）。
 * 提交人与事项本人：终审、特批节点一律不能审（回避，场景 12）；审核节点也不能审自己提交的（部门负责人自己提交的部门负责人一级例外：
 * 负责人自己发起视同负责人已确认，见 engine 的自动通过）。
 */
export function seatsFor(node: GfNode, who: number, ctx: SeatContext): (GfRole | 'dept_head' | 'performer')[] {
  const recused = recusedOf(ctx);
  if (recused.has(who)) return [];
  return seatsOf(node).filter((seat) => {
    if (seat === 'dept_head') return ctx.deptHeadId === who;
    if (seat === 'performer') return ctx.performerId === who;
    return (ctx.members[seat] ?? []).includes(who);
  });
}

// ───────────────────────── 流程状态（P01-09，从真实单据算，不另建状态表） ─────────────────────────

export const GF_STATUSES = ['draft', 'reviewing', 'to_execute', 'executing', 'completed', 'archived', 'returned', 'rejected', 'withdrawn', 'special_backfill', 'backfill_pending'] as const;
export type GfStatus = (typeof GF_STATUSES)[number];
export const GF_STATUS_LABELS: Record<GfStatus, string> = {
  draft: '草稿',
  reviewing: '审核中',
  to_execute: '待执行',
  executing: '执行中',
  completed: '已完成',
  archived: '已归档',
  returned: '退回',
  rejected: '驳回',
  withdrawn: '撤回',
  special_backfill: '特批待补登',
  backfill_pending: '后补待完成',
};

export type GfFlowStatus = 'pending' | 'approved' | 'returned' | 'rejected' | 'cancelled';

export interface StatusFacts {
  /** 最近一轮审批的状态（没提交过为空） */
  flow: GfFlowStatus | null;
  withdrawn: boolean;
  execStarted: boolean;
  completed: boolean;
  archived: boolean;
  /** 关联的微信特批还没补登 */
  specialUnfilled: boolean;
  /** 完成了但还有后补没交（发票后补、最终版文件……） */
  backfillOpen: boolean;
  /** 执行 / 补登的期限（YYYY-MM-DD），过了算逾期 */
  dueOn: string | null;
  today: string;
}

export interface DerivedStatus {
  status: GfStatus;
  overdue: boolean;
}

/** 状态机：草稿→审核中→待执行→执行中→已完成→已归档，另有退回/驳回/撤回/特批待补登/后补待完成，逾期是另外一个标记 */
export function deriveStatus(f: StatusFacts): DerivedStatus {
  let status: GfStatus;
  if (f.archived) status = 'archived';
  else if (f.withdrawn) status = 'withdrawn';
  else if (f.specialUnfilled) status = 'special_backfill';
  else if (f.completed) status = f.backfillOpen ? 'backfill_pending' : 'completed';
  else if (f.flow === null || f.flow === 'cancelled') status = 'draft';
  else if (f.flow === 'pending') status = 'reviewing';
  else if (f.flow === 'returned') status = 'returned';
  else if (f.flow === 'rejected') status = 'rejected';
  else status = f.execStarted ? 'executing' : 'to_execute';
  const open: GfStatus[] = ['to_execute', 'executing', 'special_backfill', 'backfill_pending'];
  return { status, overdue: !!f.dueOn && f.dueOn < f.today && open.includes(status) };
}

// ───────────────────────── 工作日 ─────────────────────────

/** 从 day 起往后数 n 个工作日（节假日表里的 holiday 不算、workday 调休上班算；周六日默认不算） */
export function addWorkdays(day: string, n: number, holidays: ReadonlyMap<string, 'holiday' | 'workday'> = new Map()): string {
  const d = new Date(`${day}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const key = d.toISOString().slice(0, 10);
    const kind = holidays.get(key);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    if (kind === 'workday' || (!weekend && kind !== 'holiday')) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

// ───────────────────────── 单据类型（各批往里加） ─────────────────────────

export const GF_DOC_TYPES = [
  'general',
  'supplier_admission',
  'supplier_change',
  'sku_batch',
  'sku_price_change',
  'petty_purchase',
  'quota_adjust',
  'contract',
  'payment',
  'expense',
  'travel',
  'entertain',
  'seal_use',
  'hr_batch',
] as const;
export type GfDocType = (typeof GF_DOC_TYPES)[number];
export const GF_DOC_TYPE_LABELS: Record<GfDocType, string> = {
  general: '通用事项',
  supplier_admission: '供应商入库',
  supplier_change: '供应商变更',
  sku_batch: 'SKU 提报',
  sku_price_change: 'SKU 协议价变更',
  petty_purchase: '零星采购',
  quota_adjust: '月度额度核定',
  contract: '合同',
  payment: '付款申请',
  expense: '报销',
  travel: '出差申请',
  entertain: '商务招待',
  seal_use: '用印证照',
  hr_batch: 'HR 付款批次',
};

/** 金额（分）的整数比较边界：审批按「不含税」口径 */
export const YUAN = 100;
export const WAN = 10_000 * YUAN;

/**
 * 通用事项（P01 用来验证引擎）的模板：部门负责人 →（合同类）内部履约执行人 → 财务审核人与法务并行分审 → 金额终审。
 * 终审按金额：< 1 万财总、1–5 万 CFO、5–30 万 CEO、≥ 30 万 CEO → 董事长（四级以上）；重大风险 / 预付款 / 超预算至少 CFO。
 */
export function generalTemplate(input: { amountCents: number; contractLike: boolean; flags: readonly string[] }): GfNode[] {
  const nodes: GfNode[] = [{ kind: 'dept_head', stage: 'review' }];
  if (input.contractLike) nodes.push({ kind: 'performer', stage: 'review' });
  nodes.push({ kind: 'all', roles: ['finance_reviewer', 'legal'], label: '财务、法务分别审核', stage: 'review' });
  const a = input.amountCents;
  const atLeastCfo = input.flags.some((f) => f === 'major_risk' || f === 'prepay' || f === 'over_budget');
  if (a >= 30 * WAN) nodes.push({ kind: 'role', role: 'entity_head', stage: 'review' }, { kind: 'role', role: 'chairman', stage: 'final' });
  else if (a >= 5 * WAN) nodes.push({ kind: 'role', role: 'cfo', stage: 'review' }, { kind: 'role', role: 'entity_head', stage: 'final' });
  else if (a >= 1 * WAN || atLeastCfo) nodes.push({ kind: 'role', role: 'cfo', stage: 'final' });
  else nodes.push({ kind: 'role', role: 'finance_chief', stage: 'final' });
  return nodes;
}

/** 财总＋CFO 会签节点（备用金超额特批、HR 付款、月度额度核定复用） */
export const COSIGN_FINANCE_CFO: GfNode = { kind: 'all', roles: ['finance_chief', 'cfo'], label: '财总＋CFO 共同审批', stage: 'special' };

// ───────────────────────── 知会（CC） ─────────────────────────

/** 知会对象（P01-04）：董事长、业态总经理、财总、CFO */
export const GF_CC_ROLES: readonly GfRole[] = ['chairman', 'business_gm', 'finance_chief', 'cfo'];
/** 即时提醒：大额（≥ 5 万）、异常、特批、紧急、重大风险；其他进日报 */
export const GF_CC_URGENT_CENTS = 5 * WAN;
export const ccUrgent = (amountCents: number | null, flags: readonly string[], special: boolean) =>
  special || (amountCents !== null && amountCents >= GF_CC_URGENT_CENTS) || flags.some((f) => f === 'abnormal' || f === 'urgent' || f === 'major_risk');

/** 知会名单：去掉已经在审批链里出过结论（参与审批）的人和提交人，同一人只知会一次 */
export function ccTargets(candidates: readonly { staffId: number; role: GfRole }[], participants: ReadonlySet<number>, submittedBy: number) {
  const seen = new Set<number>();
  const out: { staffId: number; role: GfRole }[] = [];
  for (const c of candidates) {
    if (participants.has(c.staffId) || c.staffId === submittedBy || seen.has(c.staffId)) continue;
    seen.add(c.staffId);
    out.push(c);
  }
  return out;
}

// ───────────────────────── 微信特批（P01-08） ─────────────────────────

/** 两人微信确认后 1 个工作日内补登需求说明与 OK 截图 */
export const GF_SPECIAL_BACKFILL_WORKDAYS = 1;
export const GF_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const GF_FILE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;
export const GF_FILE_PURPOSES = ['need', 'ok_screenshot', 'attachment'] as const;
export type GfFilePurpose = (typeof GF_FILE_PURPOSES)[number];
export const GF_FILE_PURPOSE_LABELS: Record<GfFilePurpose, string> = { need: '需求说明', ok_screenshot: 'OK 截图', attachment: '附件' };

// ───────────────────────── 接口的形状 ─────────────────────────

export interface GfRoleMember {
  id: number;
  role: GfRole;
  staffId: number;
  staffName: string;
  entityId: number | null;
  entityName: string | null;
  note: string;
  createdByName: string;
  createdAt: string;
  /** 工号（登录账号）、所在部门（8.2.9，A1：同名的人分得清） */
  staffNo: string;
  departmentName: string | null;
}

/** 角色映射的变更记录（8.2.9，A1）：每一条映射的加、改、撤 */
export interface GfRoleChange {
  id: number;
  role: GfRole;
  staffName: string;
  staffNo: string;
  entityName: string | null;
  note: string;
  /** add 新加；edit 修改（替换了 replacesId 那一条）；revoke 撤销 */
  op: 'add' | 'edit' | 'revoke';
  /** 修改时被替换的那一条的人 */
  replacedStaffName: string | null;
  reason: string;
  byName: string;
  at: string;
}

export interface GfMeta {
  roles: { role: GfRole; label: string }[];
  myRoles: GfRole[];
  canManageRoles: boolean;
  entities: { id: number; name: string }[];
  departments: { id: number; name: string; headId: number | null; headName: string | null }[];
  staff: { id: number; name: string }[];
}

export interface GfNodeView {
  level: number;
  label: string;
  stage: GfStage;
  state: 'done' | 'current' | 'waiting' | 'returned' | 'rejected' | 'skipped';
  /** 这一级还要哪些席位出结论 */
  waiting: string[];
  /** 现在能审这一级的人（姓名） */
  eligibleNames: string[];
}

export interface GfActionView {
  id: number;
  level: number;
  action: 'approve' | 'return' | 'reject' | 'skip';
  seat: string;
  actorName: string;
  comment: string;
  createdAt: string;
}

export interface GfDocCard {
  id: number;
  bizNo: string;
  docType: GfDocType;
  title: string;
  amountCents: number | null;
  departmentName: string | null;
  entityName: string | null;
  flags: GfFlag[];
  status: GfStatus;
  overdue: boolean;
  createdByName: string;
  createdAt: string;
  currentLabel: string | null;
  canAct: boolean;
}

export interface GfDocDetail extends GfDocCard {
  /** 业务单据的关联（供应商、SKU……），不放敏感信息 */
  payload: Record<string, unknown>;
  departmentId: number | null;
  entityId: number | null;
  performerId: number | null;
  performerName: string | null;
  subjectStaffId: number | null;
  note: string;
  version: number;
  flowId: number | null;
  round: number;
  currentLevel: number | null;
  nodes: GfNodeView[];
  notes: string[];
  actions: GfActionView[];
  cc: { staffName: string; role: GfRole; urgent: boolean; notifiedAt: string | null; readAt: string | null }[];
  specials: GfSpecialView[];
  /** 我在当前这一级能坐的席位 */
  mySeats: string[];
  canWithdraw: boolean;
  canSubmit: boolean;
  canExecute: boolean;
}

export interface GfSpecialView {
  id: number;
  specialNo: string;
  docId: number | null;
  docBizNo: string | null;
  title: string;
  amountCents: number;
  reason: string;
  confirmerNames: string[];
  confirmedAt: string;
  dueOn: string;
  backfilledAt: string | null;
  backfilledByName: string | null;
  backfillNote: string;
  files: { id: number; purpose: GfFilePurpose; fileName: string; sizeBytes: number }[];
  overdue: boolean;
  registeredByName: string;
  /** 同一张 OK 截图也用在了这些特批上（8.2.11，WB7：只提示） */
  screenshotReusedIn: string[];
}
