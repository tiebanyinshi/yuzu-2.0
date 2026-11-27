// 业财法「流程与阈值」（8.2.10，《业财法审批与 WCP 需求变更》A2，WB4，设计见 docs/V8210_GF_CONFIG.md）。两端共用的形状与纯校验。
//   · 每类事项可以存一份自己的流程（按顺序的节点 + 知会角色），不存就用代码里的内置流程；每次保存追加一版，在途单不受影响
//     （提交时排好的链已经存在那一轮审批上）。节点只用引擎已有的四种：部门负责人、内部履约执行人、某个角色（或签）、几个角色各一人（会签）。
//   · 零星采购超额的「财总＋CFO 合并特批」是额度规则加的，改了流程也照样追加在最后。

import { GF_DOC_TYPES, GF_ROLES, type GfDocType, type GfNode, type GfRole, type GfStage } from './govflow';
import type { GfRules, PettyPreview } from './govflow-petty';

/** 一份自定义流程最多几级 */
export const GF_CONFIG_MAX_NODES = 6;
/** 会签最多几个角色 */
export const GF_CONFIG_MAX_COSIGN = 3;

/** 单据上没有费用承担部门的（不能放「部门负责人」） */
const NO_DEPT: readonly GfDocType[] = ['supplier_admission', 'supplier_change', 'sku_batch', 'sku_price_change'];
/** 单据上能选内部履约执行人的（只有这几类能放「内部履约执行人」） */
const HAS_PERFORMER: readonly GfDocType[] = ['general', 'contract'];
export const configAllowsDeptHead = (t: GfDocType) => !NO_DEPT.includes(t);
export const configAllowsPerformer = (t: GfDocType) => HAS_PERFORMER.includes(t);

/** 内置流程怎么排（列表上的一句话；具体排出来什么用试算看） */
export const GF_BUILTIN_FLOW_NOTES: Record<GfDocType, string> = {
  general: '部门负责人 →（合同类）履约执行人 → 财务、法务分别审核 → 按金额终审（< 1 万财总、1–5 万 CFO、5–30 万 CEO、≥ 30 万董事长）',
  supplier_admission: '供应链负责人 → 董事长',
  supplier_change: '同供应商入库',
  sku_batch: '核心品类：供应链负责人 → 董事长；其余供应链负责人终审',
  sku_price_change: '同供应商入库',
  petty_purchase: '部门负责人 → 财务审核人（超出基础审核的由升级审核角色审）；超额度加财总＋CFO 合并特批',
  quota_adjust: '财总＋CFO 共同审批',
  contract: '按合同类型与金额：部门负责人 → 履约执行人 → 财法分审 → 终审',
  payment: '按有无合同、类别、金额、预付、发票情况排',
  expense: '按有没有发票、是否逾期报销排',
  travel: '按金额、是否事前申请、超标、超预算排',
  entertain: '按金额、是否事前申请排',
  seal_use: '按用印类别、合同是否原样、风险排',
  hr_batch: '（部分类型先部门负责人）→ 人力资源 → 财务审核人 → 财总＋CFO 共同审批 → 出纳',
};

/** 试算时内置流程要看单据里的哪些字段（payload），不填按默认 */
export const GF_PREVIEW_PAYLOAD_HINTS: Partial<Record<GfDocType, string>> = {
  general: 'contractLike（合同类，true / false）',
  sku_batch: 'core（核心品类）',
  petty_purchase: 'qty（件数）、urgent（紧急）、supplierName（供应商，算同日合并）',
  contract: 'type（合同类型）',
  payment: 'category、contractDocId、prepay、invoice、specialId',
  expense: 'invoiceNo（有票）、lateClaim（逾期报销）',
  travel: 'priorApplied、overStandard、overBudget、overBudgetMode',
  entertain: 'priorApplied（事前申请）',
  seal_use: 'kind、contractUnchanged、highRisk',
  hr_batch: 'kind（批次类型）',
};

/** 一级的配置（存的就是引擎的节点，不另造一套） */
export type GfConfigNode = GfNode;

/**
 * 校验一份自定义流程（纯函数，接口与页面共用）：1–6 级；角色都在角色清单里；会签 2–3 个不同的角色；
 * 没有部门的事项不能放部门负责人，不能选履约执行人的事项不能放履约执行人。返回问题清单，空 = 通过。
 */
export function flowConfigProblems(docType: GfDocType, nodes: readonly GfConfigNode[]): string[] {
  const out: string[] = [];
  if (!(GF_DOC_TYPES as readonly string[]).includes(docType)) return ['没有这类事项'];
  if (nodes.length < 1) out.push('至少要有 1 级');
  if (nodes.length > GF_CONFIG_MAX_NODES) out.push(`最多 ${GF_CONFIG_MAX_NODES} 级`);
  const isRole = (r: string) => (GF_ROLES as readonly string[]).includes(r);
  nodes.forEach((n, i) => {
    const at = `第 ${i + 1} 级`;
    if (n.kind === 'dept_head' && !configAllowsDeptHead(docType)) out.push(`${at}：这类事项没有费用承担部门，不能由部门负责人审`);
    if (n.kind === 'performer' && !configAllowsPerformer(docType)) out.push(`${at}：这类事项不选内部履约执行人，不能放这一级`);
    if (n.kind === 'role' && !isRole(n.role)) out.push(`${at}：角色不对`);
    if (n.kind === 'all') {
      if (n.roles.some((r) => !isRole(r))) out.push(`${at}：角色不对`);
      if (new Set(n.roles).size !== n.roles.length) out.push(`${at}：会签里同一个角色只能放一次`);
      if (n.roles.length < 2) out.push(`${at}：会签至少要 2 个角色（只有一个角色请选「或签」）`);
      if (n.roles.length > GF_CONFIG_MAX_COSIGN) out.push(`${at}：会签最多 ${GF_CONFIG_MAX_COSIGN} 个角色`);
    }
  });
  return out;
}

// ───────────────────────── 接口的形状 ─────────────────────────

/** 一类事项现在用的流程 */
export interface GfFlowConfigView {
  docType: GfDocType;
  label: string;
  builtinNote: string;
  /** 现在生效的自定义流程；空 = 用内置的 */
  active: {
    version: number;
    /** 空 = 审批链用内置的（只改了知会） */
    nodes: GfConfigNode[] | null;
    nodeLabels: string[] | null;
    /** 空 = 知会用内置的 */
    ccRoles: GfRole[] | null;
    note: string;
    byName: string;
    at: string;
  } | null;
  /** 最近一次保存（含清除）：第几版、谁、什么时候 */
  lastChange: { version: number; cleared: boolean; byName: string; at: string } | null;
  allowsDeptHead: boolean;
  allowsPerformer: boolean;
  payloadHint: string | null;
}

export interface GfConfigOverview {
  rules: GfRules;
  defaults: GfRules;
  rulesUpdatedBy: string | null;
  rulesUpdatedAt: string | null;
  flows: GfFlowConfigView[];
}

/** 试算结果 */
export interface GfPreviewResult {
  docType: GfDocType;
  source: 'builtin' | 'override';
  version: number | null;
  nodes: {
    level: number;
    label: string;
    stage: GfStage;
    seats: { seat: string; label: string; names: string[]; selfSkip: boolean }[];
  }[];
  notes: string[];
  cc: { role: GfRole; label: string; names: string[] }[];
  /** 提交时会被拦的问题（没有部门负责人、某一级没人能审……）：这里只提示，不报错 */
  warnings: string[];
  petty: (Pick<PettyPreview, 'tier' | 'quota' | 'purchaseDept'> & { escalationRole: GfRole | null }) | null;
}
