// 业财法 P02：供应商与商品 SKU 两级库（docs/APPROVAL_V4.md 第 6 节）。两端共用的规则与形状。
//   · 一级供应商库：经办人建档 → 供应链负责人 → 董事长 → 正式入库（知会 CFO、财总）；状态 待准入 / 审核中 / 已入库 / 停用 / 退出；
//     按统一社会信用代码查重（带校验位）；资料「统一必填 + 按品类触发」；
//   · 二级 SKU 库：每个 SKU 归属已入库供应商、映射一个集团物料，记适用经营主体 / 业态与价格版本；同一供应商一批 SKU 一张单提报、逐个建码；
//     董事长批量审批带差异摘要，异常 SKU 单独列、要逐个给结论，不能一键全过；
//   · 核心变更（主体、税号、收款账户、核心资质、SKU 协议价）走 供应链负责人 → 董事长，一般资料供应链负责人审核留痕；审核期间不能再发起变更、不算库内简化。

/** 统一社会信用代码（GB 32100-2015）：18 位，最后一位是校验位 */
const CREDIT_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const CREDIT_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
export function creditCodeProblem(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (!/^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(code)) return '统一社会信用代码是 18 位数字或大写字母（不含 I、O、Z、S、V）';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CREDIT_CHARS.indexOf(code[i]!) * CREDIT_WEIGHTS[i]!;
  const check = CREDIT_CHARS[(31 - (sum % 31)) % 31];
  return check === code[17] ? null : '统一社会信用代码校验位不对，请核对营业执照';
}
/** 合成数据用：给 17 位本体补上校验位 */
export function withCreditCheck(body17: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CREDIT_CHARS.indexOf(body17[i]!) * CREDIT_WEIGHTS[i]!;
  return body17 + CREDIT_CHARS[(31 - (sum % 31)) % 31];
}

export const SUPPLIER_STATUSES = ['pending', 'reviewing', 'active', 'disabled', 'exited'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];
export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = { pending: '待准入', reviewing: '审核中', active: '已入库', disabled: '停用', exited: '退出' };

/** 供应品类（触发不同的必备资料） */
export const SUPPLY_CATEGORIES = ['general', 'food', 'engineering', 'equipment', 'chemical', 'service'] as const;
export type SupplyCategory = (typeof SUPPLY_CATEGORIES)[number];
export const SUPPLY_CATEGORY_LABELS: Record<SupplyCategory, string> = {
  general: '一般物资',
  food: '食品饮料',
  engineering: '工程施工',
  equipment: '设备',
  chemical: '化学品（洗涤消毒）',
  service: '服务外包',
};

export const QUALIFICATION_KINDS = [
  'business_license',
  'bank_account_proof',
  'food_license',
  'construction_qualification',
  'safety_license',
  'product_certificate',
  'hazardous_license',
  'service_qualification',
] as const;
export type QualificationKind = (typeof QUALIFICATION_KINDS)[number];
export const QUALIFICATION_LABELS: Record<QualificationKind, string> = {
  business_license: '营业执照',
  bank_account_proof: '开户许可 / 银行账户证明',
  food_license: '食品经营许可证',
  construction_qualification: '建筑施工资质',
  safety_license: '安全生产许可证',
  product_certificate: '产品合格证 / 检测报告',
  hazardous_license: '危险化学品经营许可证',
  service_qualification: '服务资质证明',
};
/** 统一必填 */
export const BASE_QUALIFICATIONS: readonly QualificationKind[] = ['business_license', 'bank_account_proof'];
/** 按品类触发 */
export const CATEGORY_QUALIFICATIONS: Record<SupplyCategory, readonly QualificationKind[]> = {
  general: [],
  food: ['food_license'],
  engineering: ['construction_qualification', 'safety_license'],
  equipment: ['product_certificate'],
  chemical: ['hazardous_license'],
  service: ['service_qualification'],
};
/** 核心资质（变更走董事长） */
export const CORE_QUALIFICATIONS: readonly QualificationKind[] = ['business_license', 'bank_account_proof', 'food_license', 'construction_qualification', 'hazardous_license'];

export interface Qualification {
  kind: QualificationKind;
  no: string;
  /** 到期日（长期有效为空） */
  expiresOn: string | null;
}

/** 这些品类要哪些资料 */
export function requiredQualifications(categories: readonly SupplyCategory[]): QualificationKind[] {
  return [...new Set([...BASE_QUALIFICATIONS, ...categories.flatMap((c) => CATEGORY_QUALIFICATIONS[c])])];
}
/** 缺的、过期的资料（today 当天到期的算有效） */
export function qualificationProblems(categories: readonly SupplyCategory[], quals: readonly Qualification[], today: string): string[] {
  const out: string[] = [];
  for (const kind of requiredQualifications(categories)) {
    const q = quals.find((x) => x.kind === kind && x.no.trim());
    if (!q) out.push(`缺「${QUALIFICATION_LABELS[kind]}」`);
    else if (q.expiresOn && q.expiresOn < today) out.push(`「${QUALIFICATION_LABELS[kind]}」已过期（${q.expiresOn}）`);
  }
  return out;
}

/** 供应商的字段：哪些是核心（变更走 供应链负责人 → 董事长） */
export const SUPPLIER_CORE_FIELDS = ['name', 'creditCode', 'bankName', 'bankAccount', 'accountName', 'qualifications'] as const;
export const SUPPLIER_GENERAL_FIELDS = ['contact', 'phone', 'address', 'categories', 'note'] as const;
export type SupplierField = (typeof SUPPLIER_CORE_FIELDS)[number] | (typeof SUPPLIER_GENERAL_FIELDS)[number];
export const SUPPLIER_FIELD_LABELS: Record<SupplierField, string> = {
  name: '主体名称',
  creditCode: '统一社会信用代码（税号）',
  bankName: '开户行',
  bankAccount: '收款账号',
  accountName: '账户名',
  qualifications: '资质',
  contact: '联系人',
  phone: '电话',
  address: '地址',
  categories: '供应品类',
  note: '备注',
};

/** 资质的变更算不算核心：只动了非核心资质的不算 */
export function isCoreChange(fields: readonly SupplierField[], before: readonly Qualification[] = [], after: readonly Qualification[] = []): boolean {
  if (fields.some((f) => f !== 'qualifications' && (SUPPLIER_CORE_FIELDS as readonly string[]).includes(f))) return true;
  if (!fields.includes('qualifications')) return false;
  const key = (q: Qualification) => `${q.kind}|${q.no}|${q.expiresOn ?? ''}`;
  const b = new Set(before.filter((q) => CORE_QUALIFICATIONS.includes(q.kind)).map(key));
  const a = new Set(after.filter((q) => CORE_QUALIFICATIONS.includes(q.kind)).map(key));
  return b.size !== a.size || [...a].some((k) => !b.has(k));
}

// ───────────────────────── SKU ─────────────────────────

export const SKU_STATUSES = ['reviewing', 'active', 'rejected', 'disabled'] as const;
export type SkuStatus = (typeof SKU_STATUSES)[number];
export const SKU_STATUS_LABELS: Record<SkuStatus, string> = { reviewing: '审核中', active: '有效', rejected: '未通过', disabled: '停用' };

/** 业态 */
export const BUSINESS_FORMATS = ['汤崎', '池里', 'PAJAMA', '新生乐园'] as const;

/** 比集团物料现有最低有效协议价高出 10% 以上算价格异常 */
export const SKU_PRICE_TOLERANCE_BP = 1000;

export type SkuAbnormal = 'price_high' | 'core_category' | 'price_jump';
export const SKU_ABNORMAL_LABELS: Record<SkuAbnormal, string> = {
  price_high: '比同物料最低有效价高 10% 以上',
  core_category: '核心品类',
  price_jump: '比上一版价格变动超过 10%',
};

/** 一个 SKU 的异常（refCents：同一集团物料现有有效 SKU 的最低价；prevCents：这个 SKU 上一版价格） */
export function skuAbnormal(input: { priceCents: number; refCents: number | null; prevCents: number | null; core: boolean }): SkuAbnormal[] {
  const out: SkuAbnormal[] = [];
  const over = (base: number) => input.priceCents * 10_000 > base * (10_000 + SKU_PRICE_TOLERANCE_BP);
  if (input.refCents !== null && over(input.refCents)) out.push('price_high');
  if (input.core) out.push('core_category');
  if (input.prevCents !== null && Math.abs(input.priceCents - input.prevCents) * 10_000 > input.prevCents * SKU_PRICE_TOLERANCE_BP) out.push('price_jump');
  return out;
}

// ───────────────────────── 接口的形状 ─────────────────────────

export interface GfMaterial {
  id: number;
  code: string;
  name: string;
  category: SupplyCategory;
  unit: string;
  core: boolean;
  active: boolean;
}

export interface GfSupplierView {
  id: number;
  supplierNo: string;
  name: string;
  creditCode: string;
  categories: SupplyCategory[];
  contact: string;
  phone: string;
  address: string;
  bankName: string;
  /** 没有权限的只给尾号 */
  bankAccount: string;
  accountName: string;
  bankMasked: boolean;
  qualifications: Qualification[];
  note: string;
  status: SupplierStatus;
  legacy: boolean;
  version: number;
  /** 在审的变更（审核期间不能再变更、不算库内简化） */
  pendingChangeDocId: number | null;
  admissionDocId: number | null;
  missing: string[];
  createdByName: string;
  createdAt: string;
  skuCount: number;
}

export interface GfSkuView {
  id: number;
  skuCode: string;
  supplierId: number;
  supplierName: string;
  materialId: number;
  materialName: string;
  name: string;
  spec: string;
  unit: string;
  /** 现行协议价（不含税，分）；没批的是提报价 */
  priceCents: number;
  priceVersion: number;
  taxRateBp: number;
  entityIds: number[];
  formats: string[];
  status: SkuStatus;
  pendingChangeDocId: number | null;
  docId: number | null;
}

/** 董事长批 SKU 时看到的差异摘要 */
export interface SkuBatchReview {
  docId: number;
  supplierName: string;
  count: number;
  totalCents: number;
  normal: { skuId: number; skuCode: string; name: string; priceCents: number; refCents: number | null }[];
  abnormal: { skuId: number; skuCode: string; name: string; priceCents: number; refCents: number | null; prevCents: number | null; reasons: SkuAbnormal[] }[];
  /** 已经逐个给过结论的（同意 / 不同意） */
  decisions: Record<number, 'approve' | 'reject'>;
}

export interface SupplierImportResult {
  created: number;
  skipped: { row: number; name: string; reason: string }[];
}
