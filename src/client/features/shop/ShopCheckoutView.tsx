// 采购商城 · 三步分步结算表单（批次 F2：FR-07 三步分步与草稿留存 + UX-03 确认页 + UX-06 色点紧急度 + FR-12 移动端底部固定操作栏）。
// 提交接口字段与幂等重提链路完全沿用原 Checkout / useSubmit（不改任何后端接口或操作编号逻辑）。

import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatYuan } from '@shared/money';
import { formatQty } from '@shared/quantity';
import { PAYMENT_INTENT_LABELS, PRIORITY_LABELS, REQUEST_PRIORITIES, type MallPaymentIntent, type RequestPriority } from '@shared/requests';
import { groupShopCart, type ShopCart, type ShopCatalog } from '@shared/shop';
import { cn } from '../../lib/utils';
import { Badge, Button, Card, Field, Input, Notice, Select, Textarea } from '../../components/ui';
import { PriorityDot } from '../requests/parts';

const BASE = '/erp/shop';

interface CheckoutHeaderState {
  departmentId: string;
  entityId: string;
  contactName: string;
  budgetProject: string;
  needBy: string;
  deliveryAddress: string;
  paymentIntent: MallPaymentIntent;
  priority: RequestPriority;
  note: string;
  purpose: string;
}

const PRIORITY_HINT: Record<RequestPriority, string> = {
  urgent: '希望尽快采购（不跳过主管确认；正式的紧急采购仍按规定特批）',
  high: '有明确时间要求，请优先安排',
  normal: '按正常采购周期',
};

type Step = 1 | 2 | 3;

const STEPS: { id: Step; title: string; short: string }[] = [
  { id: 1, title: '① 采购业务信息', short: '业务信息' },
  { id: 2, title: '② 交付要求', short: '交付要求' },
  { id: 3, title: '③ 提交前确认', short: '提交确认' },
];

function draftKeyFor(staffId: number) {
  return `yuzu.shop.checkoutDraft.${staffId}`;
}

function defaultState(c: ShopCatalog): CheckoutHeaderState {
  return {
    departmentId: c.me.departmentId ? String(c.me.departmentId) : '',
    entityId: String(c.stores.find((s) => s.id === c.storeId)?.entityId ?? ''),
    contactName: '',
    budgetProject: '',
    needBy: '',
    deliveryAddress: '',
    paymentIntent: 'company_direct',
    priority: 'normal',
    note: '',
    purpose: c.purposes.includes('其他') ? '其他' : (c.purposes[0] ?? ''),
  };
}

function loadDraft(c: ShopCatalog, staffId: number): CheckoutHeaderState {
  const base = defaultState(c);
  try {
    const raw = sessionStorage.getItem(draftKeyFor(staffId));
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<CheckoutHeaderState>;
    const validDept = c.me.canPickDepartment ? (saved.departmentId && c.departments.some((d) => String(d.id) === saved.departmentId) ? saved.departmentId : base.departmentId) : base.departmentId;
    const validEntity = saved.entityId && c.entities.some((e) => String(e.id) === saved.entityId) ? saved.entityId : base.entityId;
    const validPurpose = saved.purpose && c.purposes.includes(saved.purpose) ? saved.purpose : base.purpose;
    const validNeedBy = saved.needBy && saved.needBy >= c.today ? saved.needBy : '';
    const validPay: MallPaymentIntent = saved.paymentIntent === 'dept_petty' ? 'dept_petty' : 'company_direct';
    const validPriority: RequestPriority = saved.priority && REQUEST_PRIORITIES.includes(saved.priority) ? saved.priority : 'normal';
    return {
      departmentId: validDept,
      entityId: validEntity,
      contactName: typeof saved.contactName === 'string' ? saved.contactName : '',
      budgetProject: typeof saved.budgetProject === 'string' ? saved.budgetProject : '',
      needBy: validNeedBy,
      deliveryAddress: typeof saved.deliveryAddress === 'string' ? saved.deliveryAddress : '',
      paymentIntent: validPay,
      priority: validPriority,
      note: typeof saved.note === 'string' ? saved.note : '',
      purpose: validPurpose,
    };
  } catch {
    return base;
  }
}

function clearCheckoutDraft(staffId: number) {
  try {
    sessionStorage.removeItem(draftKeyFor(staffId));
  } catch {
    // 隐私模式静默忽略
  }
}

function validateStep1(f: CheckoutHeaderState, c: ShopCatalog): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!f.departmentId) errs.departmentId = c.me.canPickDepartment ? '请选择申请部门' : '员工档案尚未填写所属部门，请联系店主补齐';
  if (!f.entityId) errs.entityId = '请选择费用承担主体';
  if (!f.budgetProject.trim()) errs.budgetProject = '请填写预算项目 / 费用归属';
  return errs;
}

function validateStep2(f: CheckoutHeaderState, c: ShopCatalog): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!f.needBy) errs.needBy = '请选择期望到货日期';
  else if (f.needBy < c.today) errs.needBy = `期望到货日期不能早于今天（${c.today}）`;
  if (!f.deliveryAddress.trim()) errs.deliveryAddress = '请填写收货地点';
  return errs;
}

export function ShopCheckoutView({
  c,
  cart,
  staffId,
  staffDisplayName,
  busy,
  blocked,
  submitted,
  onSubmit,
  renderRoutePreview,
}: {
  c: ShopCatalog;
  cart: ShopCart;
  staffId: number;
  staffDisplayName: string;
  busy: boolean;
  blocked: boolean;
  submitted: boolean;
  onSubmit: (body: Record<string, unknown>, summary: string) => void;
  renderRoutePreview: (f: CheckoutHeaderState) => ReactNode;
}) {
  const [f, setF] = useState<CheckoutHeaderState>(() => loadDraft(c, staffId));
  const [step, setStep] = useState<Step>(1);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // 草稿自动保存：退出重进保留所填业务信息；提交成功后清理草稿
  useEffect(() => {
    if (submitted) {
      clearCheckoutDraft(staffId);
      return;
    }
    try {
      sessionStorage.setItem(draftKeyFor(staffId), JSON.stringify(f));
    } catch {
      // 隐私模式无法写 sessionStorage 时静默降级
    }
  }, [f, staffId, submitted]);

  if (!cart.lines.length) return submitted ? null : <Navigate to={`${BASE}/cart`} replace />;

  const summary = groupShopCart(c, cart);
  const bad = summary.issues.length > 0 || !summary.sameStore;

  const update = (patch: Partial<CheckoutHeaderState>) => {
    setF((prev) => ({ ...prev, ...patch }));
    const keys = Object.keys(patch);
    setErrors((prev) => {
      if (!keys.some((k) => prev[k])) return prev;
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  };

  const goTo = (target: Step) => {
    if (target > 1) {
      const e1 = validateStep1(f, c);
      if (Object.keys(e1).length > 0) {
        setErrors(e1);
        setStep(1);
        return;
      }
    }
    if (target > 2) {
      const e2 = validateStep2(f, c);
      if (Object.keys(e2).length > 0) {
        setErrors(e2);
        setStep(2);
        return;
      }
    }
    setErrors({});
    setStep(target);
  };

  const handleSubmit = () => {
    const e1 = validateStep1(f, c);
    if (Object.keys(e1).length > 0) {
      setErrors(e1);
      setStep(1);
      return;
    }
    const e2 = validateStep2(f, c);
    if (Object.keys(e2).length > 0) {
      setErrors(e2);
      setStep(2);
      return;
    }
    const firstItemName = summary.groups[0]?.rows[0]?.item?.material.name ?? '';
    const summaryText = `${firstItemName}${summary.lineCount > 1 ? ` 等 ${summary.lineCount} 行` : ''}`;
    onSubmit(
      {
        storeId: c.storeId,
        departmentId: f.departmentId ? Number(f.departmentId) : null,
        entityId: Number(f.entityId),
        contactName: f.contactName.trim() || staffDisplayName,
        budgetProject: f.budgetProject.trim(),
        needBy: f.needBy,
        deliveryAddress: f.deliveryAddress.trim(),
        paymentIntent: f.paymentIntent,
        priority: f.priority,
        note: f.note.trim(),
        purpose: f.purpose,
        kind: 'catalog',
        lines: cart.lines,
      },
      summaryText,
    );
  };

  const deptLabel = c.me.canPickDepartment ? (c.departments.find((d) => String(d.id) === f.departmentId)?.name ?? '未选择') : (c.me.departmentName ?? '未设置部门');
  const entityLabel = c.entities.find((e) => String(e.id) === f.entityId)?.name ?? '未选择';
  const storeName = c.stores.find((s) => s.id === c.storeId)?.name ?? `门店 ${c.storeId}`;

  return (
    <div className="space-y-4" data-testid="shop-checkout">
      {/* 顶部三步进度条（UX-03） */}
      <ol className="grid grid-cols-3 gap-2" aria-label="提交步骤" data-testid="shop-checkout-steps">
        {STEPS.map((s) => {
          const isCurrent = step === s.id;
          const isDone = step > s.id;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => goTo(s.id)}
                data-testid={`shop-checkout-step-${s.id}`}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'tap relative flex w-full items-center justify-center gap-1.5 rounded-xl border px-2.5 py-2.5 text-[13px] font-semibold transition-colors',
                  isCurrent ? 'border-pine bg-pine text-paper' : isDone ? 'border-pine/40 bg-pine-soft/40 text-pine' : 'border-line bg-card text-ink-2 hover:text-ink',
                )}
              >
                {isDone && <Check className="size-3.5 shrink-0" aria-hidden />}
                <span className="hidden sm:inline">{s.title}</span>
                <span className="sm:hidden">
                  {s.id}. {s.short}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {bad && (
        <Notice tone="error" title="清单里有不能提交的行" data-testid="shop-checkout-cart-error">
          请
          <Link to={`${BASE}/cart`} className="mx-1 font-semibold underline">
            返回采购清单
          </Link>
          处理（已失效、门店不一致、改过价或低于起订量）。
        </Notice>
      )}

      {/* 第 1 步：采购业务信息 */}
      {step === 1 && (
        <Card className="space-y-3 p-4" data-testid="shop-checkout-panel-1">
          <div>
            <p className="text-[14.5px] font-bold text-ink">① 采购业务信息</p>
            <p className="text-[12.5px] text-ink-3">确认申请部门、实际经办人与费用归属（自动保存草稿）。</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {c.me.canPickDepartment ? (
              <Field label="申请部门" htmlFor="shop-dept" error={errors.departmentId}>
                <Select id="shop-dept" value={f.departmentId} onChange={(e) => update({ departmentId: e.target.value })}>
                  <option value="">请选择</option>
                  {c.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="申请部门" hint={c.me.departmentId ? undefined : '请店主在员工档案里补上所属部门，补上之前提交不了'} error={errors.departmentId}>
                <Input value={c.me.departmentName ?? '（员工档案里还没填所属部门）'} disabled />
              </Field>
            )}
            <Field label="经办人" htmlFor="shop-contact" hint="部门共用账号时写实际经办的人">
              <Input id="shop-contact" value={f.contactName} maxLength={40} onChange={(e) => update({ contactName: e.target.value })} placeholder={staffDisplayName} />
            </Field>
            <Field label="费用承担主体" htmlFor="shop-entity" error={errors.entityId}>
              <Select id="shop-entity" value={f.entityId} onChange={(e) => update({ entityId: e.target.value })}>
                <option value="">请选择</option>
                {c.entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="预算项目 / 费用归属" htmlFor="shop-budget" error={errors.budgetProject}>
              <Input id="shop-budget" value={f.budgetProject} maxLength={80} onChange={(e) => update({ budgetProject: e.target.value })} placeholder="例如：布草消耗预算" />
            </Field>
          </div>
        </Card>
      )}

      {/* 第 2 步：交付要求 */}
      {step === 2 && (
        <Card className="space-y-3 p-4" data-testid="shop-checkout-panel-2">
          <div>
            <p className="text-[14.5px] font-bold text-ink">② 交付要求</p>
            <p className="text-[12.5px] text-ink-3">填清到货时间、收货地点与紧急程度。</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="期望到货日期" htmlFor="shop-needby" error={errors.needBy}>
              <Input id="shop-needby" type="date" min={c.today} value={f.needBy} onChange={(e) => update({ needBy: e.target.value })} />
            </Field>
            <Field label="收货地点" htmlFor="shop-address" error={errors.deliveryAddress}>
              <Input id="shop-address" value={f.deliveryAddress} maxLength={120} onChange={(e) => update({ deliveryAddress: e.target.value })} placeholder="例如：本店布草仓" />
            </Field>
            <Field label="用途" htmlFor="shop-purpose">
              <Select id="shop-purpose" value={f.purpose} onChange={(e) => update({ purpose: e.target.value })}>
                {c.purposes.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="拟定支付方式" htmlFor="shop-pay">
              <Select id="shop-pay" value={f.paymentIntent} onChange={(e) => update({ paymentIntent: e.target.value as MallPaymentIntent })}>
                {(Object.keys(PAYMENT_INTENT_LABELS) as MallPaymentIntent[]).map((k) => (
                  <option key={k} value={k}>
                    {PAYMENT_INTENT_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="紧急程度" hint={PRIORITY_HINT[f.priority]} className="sm:col-span-2">
              {/* UX-06：紧急度仅用「色点 + 文案」，不用整块红黄绿底色 */}
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="紧急程度">
                {REQUEST_PRIORITIES.map((p) => {
                  const selected = f.priority === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      title={PRIORITY_HINT[p]}
                      onClick={() => update({ priority: p })}
                      className={cn(
                        'tap relative inline-flex h-10 items-center gap-2 rounded-lg border bg-card px-3.5 text-[13px] font-semibold transition-colors',
                        selected ? 'border-ink text-ink ring-2 ring-ink/15' : 'border-line text-ink-2 hover:border-ink-3 hover:text-ink',
                      )}
                      data-testid={`shop-priority-${p}`}
                    >
                      <PriorityDot priority={p} />
                      <span>{PRIORITY_LABELS[p]}</span>
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="用途与补充说明" htmlFor="shop-note" className="sm:col-span-2">
              <Textarea id="shop-note" rows={2} maxLength={500} value={f.note} onChange={(e) => update({ note: e.target.value })} />
            </Field>
          </div>
        </Card>
      )}

      {/* 第 3 步：提交前确认（摘要 + 供应商分组商品 + 路由预览） */}
      {step === 3 && (
        <div className="space-y-4" data-testid="shop-checkout-panel-3">
          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[14.5px] font-bold text-ink">业务与交付信息核对</p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setStep(1)}>
                  改业务信息
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setStep(2)}>
                  改交付要求
                </Button>
              </div>
            </div>
            <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-3">
              <ConfirmInfo k="门店" v={storeName} />
              <ConfirmInfo k="申请部门" v={deptLabel} />
              <ConfirmInfo k="经办人" v={f.contactName.trim() || staffDisplayName} />
              <ConfirmInfo k="费用主体" v={entityLabel} />
              <ConfirmInfo k="预算项目" v={f.budgetProject.trim() || '—'} />
              <ConfirmInfo k="期望到货" v={f.needBy || '—'} />
              <ConfirmInfo k="收货地点" v={f.deliveryAddress.trim() || '—'} />
              <ConfirmInfo k="拟定支付" v={PAYMENT_INTENT_LABELS[f.paymentIntent]} />
              <div className="flex items-center gap-2">
                <dt className="shrink-0 text-ink-3">紧急程度</dt>
                <dd className="inline-flex items-center gap-1.5 font-semibold text-ink">
                  <PriorityDot priority={f.priority} />
                  {PRIORITY_LABELS[f.priority]}
                </dd>
              </div>
            </dl>
            {f.note.trim() && <p className="rounded-lg bg-paper-2/60 px-3 py-2 text-[12.5px] text-ink-2">补充说明：{f.note.trim()}</p>}
          </Card>

          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[14.5px] font-bold text-ink">
                采购商品清单（{summary.groups.length} 家供应商 · {summary.lineCount} 行）
              </p>
              <Link to={`${BASE}/cart`} className="text-[13px] font-semibold text-pine hover:underline">
                修改清单 →
              </Link>
            </div>
            <div className="space-y-3">
              {summary.groups.map((g) => (
                <div key={g.key} className="rounded-lg border border-line">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper-2/50 px-3 py-2 text-[13px]">
                    <span className="font-bold text-ink">{g.supplierName}</span>
                    <span className="text-[12.5px] text-ink-2">
                      {g.freightCents === 0 ? <Badge tone="pine">包邮</Badge> : `运费 ${formatYuan(g.freightCents)}`} · 小计 <strong className="text-ink">{formatYuan(g.subtotalCents)}</strong>
                    </span>
                  </div>
                  <ul className="divide-y divide-line px-3 text-[13px]">
                    {g.rows.map((r) => (
                      <li key={r.line.skuId} className="flex flex-wrap justify-between gap-2 py-2">
                        <span>
                          {r.item?.material.name ?? `SKU ${r.line.skuId}`}
                          {r.offer && <span className="text-[12.5px] text-ink-3">（V{r.offer.priceVersion}）</span>}
                        </span>
                        <span className="font-semibold">
                          {formatQty(r.line.qtyMilli)} {r.unit} · {formatYuan(r.totalCents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="text-right text-[15px] font-bold text-ink" data-testid="shop-checkout-total">
              预计含税总额 <span className="text-clay">{formatYuan(summary.totalCents)}</span>
            </p>
          </Card>

          {renderRoutePreview(f)}
        </div>
      )}

      {/* FR-12：响应式底部操作栏（窄屏吸底且带安全区留白、键盘弹出不遮挡，桌面端自然排布） */}
      <div
        className="sticky bottom-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-2 rounded-t-xl border-t border-line bg-card/95 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:mx-0 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0"
        data-testid="shop-checkout-bar"
      >
        <div className="min-w-0">
          <p className="text-[12.5px] text-ink-3">
            共 {summary.lineCount} 行 · 运费 {summary.freightCents === 0 ? '包邮' : formatYuan(summary.freightCents)}
          </p>
          <p className="text-[16px] font-bold text-clay">{formatYuan(summary.totalCents)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {step === 1 ? (
            <Link to={`${BASE}/cart`}>
              <Button variant="ghost" className="min-h-11 sm:min-h-0">
                返回清单
              </Button>
            </Link>
          ) : (
            <Button variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => setStep((step - 1) as Step)} className="min-h-11 sm:min-h-0" data-testid="shop-checkout-prev">
              上一步
            </Button>
          )}
          {step < 3 ? (
            <Button variant="primary" onClick={() => goTo((step + 1) as Step)} className="min-h-11 sm:min-h-0" data-testid="shop-checkout-next">
              下一步
              <ChevronRight className="size-4" />
            </Button>
          ) : (
            <Button variant="primary" loading={busy} disabled={bad || blocked} onClick={handleSubmit} className="min-h-11 sm:min-h-0" data-testid="shop-submit">
              提交采购需求
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfirmInfo({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-ink-3">{k}</dt>
      <dd className="min-w-0 truncate font-semibold text-ink">{v}</dd>
    </div>
  );
}
