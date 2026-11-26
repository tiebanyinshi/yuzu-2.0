// 采购商城试点（8.1.51，店主 2026-11-26，docs/MALL_V8151.md）：
//   · CustomItemFields：自主申请先选「非定制」还是「定制」，两种要填的不一样；定制写尺寸规格、材质工艺、使用场景、要不要打样、预算，附设计稿
//   · ResubmitPanel：被退回的单在原单上补资料、重新提交（单号不变）
//   · SourcingPanel：需求池接单；供应链 BP 记成交方案（微信上谈好的供应商、价格、交期、截图），部门确认或 BP 代记已在微信确认

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Hand, MessageCircle, Palette, Plus, ShoppingBag, Star, Undo2 } from 'lucide-react';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import { SHOP_CUSTOM_UNITS } from '@shared/shop';
import { MALL_CUSTOM_KIND_LABELS, PRIORITY_LABELS, REQUEST_PRIORITIES, type ImageRef, type MallCustomKind, type MallCustomSpec, type RequestPriority } from '@shared/requests';
import type { MallQuote, MallRequest, MallRequestLine } from '@shared/mall';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { ImagePicker, ImageThumbs } from '../../components/Images';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Select, Textarea } from '../../components/ui';

const imageRef = (id: number): ImageRef => ({ id, url: `/api/erp/images/${id}` });
/** 报价截图单独一类（只有采购看得到，Codex 审查） */
const QUOTE_IMAGES = '/api/erp/shop/quote-images';
const quoteImageRef = (id: number): ImageRef => ({ id, url: `${QUOTE_IMAGES}/${id}` });

// ───────────────────────── 自主申请：非定制 / 定制 ─────────────────────────

export interface CustomItemState {
  kind: MallCustomKind;
  name: string;
  expectedCategory: string;
  qty: string;
  unit: string;
  details: string;
  brandModel: string;
  link: string;
  reasonText: string;
  size: string;
  craft: string;
  scene: string;
  sample: boolean;
  budget: string;
  images: ImageRef[];
}

export const emptyCustomItem = (): CustomItemState => ({
  kind: 'standard',
  name: '',
  expectedCategory: '',
  qty: '1',
  unit: '个',
  details: '',
  brandModel: '',
  link: '',
  reasonText: '',
  size: '',
  craft: '',
  scene: '',
  sample: false,
  budget: '',
  images: [],
});

/** 拆掉服务端拼在前面的「【定制】……」那一段，回显部门自己写的说明 */
const plainDetails = (details: string, kind: MallCustomKind | null) => {
  if (kind !== 'custom' || !details.startsWith('【定制】')) return details;
  const i = details.indexOf('\n');
  return i < 0 ? '' : details.slice(i + 1);
};

/** 详情页一行的说明：定制的要求另外列（CustomSpecView），这里只写部门自己写的那段 */
export const lineDetailsText = (l: MallRequestLine) => plainDetails(l.details, l.customKind);

/** 已提交的一行回填成表单（原单补资料用） */
export const customItemFrom = (l: MallRequestLine): CustomItemState => ({
  kind: l.customKind ?? 'standard',
  name: l.name,
  expectedCategory: l.expectedCategory,
  qty: formatQty(l.qtyMilli).replace(/,/g, ''),
  unit: l.unit,
  details: plainDetails(l.details, l.customKind),
  brandModel: l.brandModel,
  link: l.link,
  reasonText: l.reasonText,
  size: l.customSpec?.size ?? '',
  craft: l.customSpec?.craft ?? '',
  scene: l.customSpec?.scene ?? '',
  sample: l.customSpec?.sample ?? false,
  budget: l.customSpec?.budgetCents != null ? centsToInput(l.customSpec.budgetCents) : '',
  images: l.imageIds.map(imageRef),
});

/** 还差什么（空 = 可以提交） */
export function customItemProblem(s: CustomItemState): string | null {
  if (!s.name.trim()) return '请填写物品名称';
  if (!parseQty(s.qty)) return '请填写数量';
  if (s.link && !/^https?:\/\/\S+$/i.test(s.link)) return '参考链接要以 http:// 或 https:// 开头';
  if (s.kind === 'standard' && !s.details.trim()) return '请填写规格型号';
  if (s.kind === 'custom' && !s.size.trim() && !s.craft.trim() && !s.details.trim()) return '定制请至少写清尺寸规格、材质工艺或设计要求';
  if (s.budget && parseYuan(s.budget) === null) return '预算金额格式不对';
  if (!s.reasonText.trim()) return '请填写采购理由 / 使用场景';
  return null;
}

export function customItemBody(s: CustomItemState) {
  const spec: MallCustomSpec | null =
    s.kind === 'custom' ? { size: s.size.trim(), craft: s.craft.trim(), scene: s.scene.trim(), sample: s.sample, budgetCents: s.budget ? parseYuan(s.budget) : null } : null;
  return {
    name: s.name.trim(),
    expectedCategory: s.expectedCategory,
    qtyMilli: parseQty(s.qty),
    unit: s.unit,
    details: s.details.trim(),
    brandModel: s.kind === 'standard' ? s.brandModel.trim() : '',
    link: s.link.trim(),
    reasonText: s.reasonText.trim(),
    customKind: s.kind,
    customSpec: spec,
    imageIds: s.images.map((i) => i.id),
  };
}

const KIND_CARDS: { kind: MallCustomKind; icon: typeof ShoppingBag; title: string; hint: string }[] = [
  { kind: 'standard', icon: ShoppingBag, title: '非定制', hint: '市面上买得到的现成品，商城里还没有：写清规格型号、品牌，附链接或照片' },
  { kind: 'custom', icon: Palette, title: '定制', hint: '要按我们的要求做的：印刷品、工服、物料定做……写清尺寸、材质工艺、要不要打样，附设计稿' },
];

export function CustomItemFields({
  s,
  set,
  categories,
  onUploading,
  idPrefix = 'sc',
}: {
  s: CustomItemState;
  /** 也收更新函数：传图要等压缩、上传，回来时按那一刻最新的内容改（Codex 审查），不拿开始传时的旧内容盖掉中间的修改 */
  set: (s: CustomItemState | ((prev: CustomItemState) => CustomItemState)) => void;
  categories: string[];
  onUploading?: (busy: boolean) => void;
  idPrefix?: string;
}) {
  const id = (k: string) => `${idPrefix}-${k}`;
  const linkBad = !!s.link && !/^https?:\/\/\S+$/i.test(s.link);
  return (
    <div className="space-y-4">
      <div className="grid gap-2.5 sm:grid-cols-2" role="radiogroup" aria-label="定制还是非定制" data-testid={`${idPrefix}-kind`}>
        {KIND_CARDS.map((k) => {
          const on = s.kind === k.kind;
          const Icon = k.icon;
          return (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => set({ ...s, kind: k.kind })}
              className={cn(
                'tap relative flex items-start gap-3 rounded-2xl p-4 text-left ring-1 transition',
                on ? 'bg-ink text-paper ring-ink shadow-[0_12px_28px_-16px_rgb(28_35_31/0.7)]' : 'bg-card text-ink ring-line hover:ring-line-strong',
              )}
              data-testid={`${idPrefix}-kind-${k.kind}`}
            >
              <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', on ? 'bg-white/15' : 'bg-paper-2')}>
                <Icon className="size-5" />
              </span>
              <span>
                <span className="block text-[15px] font-bold">{k.title}</span>
                <span className={cn('mt-0.5 block text-[12.5px]', on ? 'text-paper/75' : 'text-ink-3')}>{k.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={s.kind === 'custom' ? '要做什么' : '物品名称'} htmlFor={id('name')}>
          <Input
            id={id('name')}
            maxLength={100}
            value={s.name}
            placeholder={s.kind === 'custom' ? '例如：店庆易拉宝、员工工牌挂绳' : '例如：订书机'}
            onChange={(e) => set({ ...s, name: e.target.value })}
          />
        </Field>
        <Field label="预期分类" htmlFor={id('cat')}>
          <Select id={id('cat')} value={s.expectedCategory} onChange={(e) => set({ ...s, expectedCategory: e.target.value })}>
            <option value="">不确定，由采购确认</option>
            {categories.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="采购数量" htmlFor={id('qty')}>
          <Input id={id('qty')} inputMode="decimal" value={s.qty} onChange={(e) => set({ ...s, qty: e.target.value })} invalid={!parseQty(s.qty)} />
        </Field>
        <Field label="单位" htmlFor={id('unit')}>
          <Select id={id('unit')} value={s.unit} onChange={(e) => set({ ...s, unit: e.target.value })}>
            {[...new Set([...SHOP_CUSTOM_UNITS, s.unit])].map((u) => (
              <option key={u}>{u}</option>
            ))}
          </Select>
        </Field>
        {s.kind === 'custom' ? (
          <>
            <Field label="尺寸 / 规格" htmlFor={id('size')} hint="例如 80×200cm、A4 双面、S/M/L 各几件">
              <Input id={id('size')} maxLength={120} value={s.size} onChange={(e) => set({ ...s, size: e.target.value })} />
            </Field>
            <Field label="材质 / 工艺" htmlFor={id('craft')} hint="例如 PP 合成纸、烫金、刺绣、热转印">
              <Input id={id('craft')} maxLength={200} value={s.craft} onChange={(e) => set({ ...s, craft: e.target.value })} />
            </Field>
            <Field label="用在哪、给谁用" htmlFor={id('scene')}>
              <Input id={id('scene')} maxLength={200} value={s.scene} onChange={(e) => set({ ...s, scene: e.target.value })} />
            </Field>
            <Field label="预算（含税总价，选填）" htmlFor={id('budget')} hint="大概多少钱以内，采购按这个找方案">
              <Input
                id={id('budget')}
                inputMode="decimal"
                value={s.budget}
                placeholder="元"
                onChange={(e) => set({ ...s, budget: e.target.value })}
                invalid={!!s.budget && parseYuan(s.budget) === null}
              />
            </Field>
            <label className="flex items-center gap-2 text-[13.5px] text-ink sm:col-span-2">
              <input type="checkbox" className="size-4 accent-pine" checked={s.sample} onChange={(e) => set({ ...s, sample: e.target.checked })} data-testid={id('sample')} />
              需要先打样，确认样品后再批量做
            </label>
            <Field label="设计要求说明" htmlFor={id('details')} className="sm:col-span-2" hint="画面、颜色、logo 位置、交付形式等；设计稿传在下面">
              <Textarea id={id('details')} rows={3} maxLength={800} value={s.details} onChange={(e) => set({ ...s, details: e.target.value })} />
            </Field>
          </>
        ) : (
          <>
            <Field label="规格型号" htmlFor={id('details')} className="sm:col-span-2" hint="写清型号、尺寸、容量等，采购照这个找货、验收">
              <Textarea id={id('details')} rows={2} maxLength={1000} value={s.details} onChange={(e) => set({ ...s, details: e.target.value })} />
            </Field>
            <Field label="品牌（如有）" htmlFor={id('model')}>
              <Input id={id('model')} maxLength={150} value={s.brandModel} onChange={(e) => set({ ...s, brandModel: e.target.value })} />
            </Field>
          </>
        )}
        <Field label="参考链接（如有）" htmlFor={id('link')} hint={linkBad ? '要以 http:// 或 https:// 开头' : undefined}>
          <Input id={id('link')} maxLength={1000} value={s.link} invalid={linkBad} onChange={(e) => set({ ...s, link: e.target.value })} />
        </Field>
        <Field label="采购理由 / 使用场景" htmlFor={id('reason')} className="sm:col-span-2" hint="为什么要买、为什么商城里的不行">
          <Textarea id={id('reason')} rows={2} maxLength={1000} value={s.reasonText} onChange={(e) => set({ ...s, reasonText: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-[13px] font-semibold text-ink-2">{s.kind === 'custom' ? '设计稿 / 参考图' : '照片 / 截图'}（选填，最多 9 张）</p>
          <ImagePicker value={s.images} onChange={(images) => set((cur) => ({ ...cur, images }))} max={9} onBusyChange={onUploading} testId={id('images')} />
        </div>
      </div>
    </div>
  );
}

/** 详情页一行的定制要求 */
export function CustomSpecView({ l }: { l: MallRequestLine }) {
  if (!l.customKind) return null;
  const s = l.customSpec;
  return (
    <div className="mt-1.5 space-y-1 text-[12.5px]" data-testid={`shop-line-custom-${l.id}`}>
      <Badge tone={l.customKind === 'custom' ? 'yuzu' : 'neutral'}>{MALL_CUSTOM_KIND_LABELS[l.customKind]}</Badge>
      {s && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-ink-2">
          {s.size && (
            <>
              <dt className="text-ink-3">尺寸规格</dt>
              <dd>{s.size}</dd>
            </>
          )}
          {s.craft && (
            <>
              <dt className="text-ink-3">材质工艺</dt>
              <dd>{s.craft}</dd>
            </>
          )}
          {s.scene && (
            <>
              <dt className="text-ink-3">使用场景</dt>
              <dd>{s.scene}</dd>
            </>
          )}
          <dt className="text-ink-3">打样</dt>
          <dd>{s.sample ? '需要先打样' : '不用打样'}</dd>
          {s.budgetCents !== null && (
            <>
              <dt className="text-ink-3">预算</dt>
              <dd>约 {formatYuan(s.budgetCents)}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

// ───────────────────────── 退回后在原单补资料 ─────────────────────────

export function ResubmitPanel({ r, categories, onDone }: { r: MallRequest; categories: string[]; onDone: (next: MallRequest) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const session = useSession();
  // 本机还有一笔补资料没确认结果（Codex 审查）：先在页面顶部查回、原样重提或确认作废，不另发新的
  const pending = useErpRecorded(['mall_resubmit']).some((op) => op.staffId === session.staff.id && op.url === `/api/erp/shop/requests/${r.id}/resubmit`);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [head, setHead] = useState({
    contactName: r.contactName,
    budgetProject: r.budgetProject,
    needBy: r.needBy ?? '',
    deliveryAddress: r.deliveryAddress,
    priority: r.priority as RequestPriority,
    note: r.note,
  });
  const [remark, setRemark] = useState('');
  const [items, setItems] = useState(() => r.lines.map((l) => ({ line: l, keep: true, qty: formatQty(l.qtyMilli).replace(/,/g, ''), custom: l.skuCode ? null : customItemFrom(l) })));
  const kept = items.filter((x) => x.keep);
  const problem =
    kept.length === 0
      ? '至少留一行'
      : (kept.map((x) => (x.custom ? customItemProblem(x.custom) : parseQty(x.qty) ? null : `「${x.line.name}」请填写数量`)).find(Boolean) ??
        (!head.contactName.trim() || !head.budgetProject.trim() || !head.needBy || !head.deliveryAddress.trim() ? '请把经办人、预算项目、期望到货、收货地点填全' : null) ??
        (!remark.trim() ? '请写一句补了什么' : null) ??
        (pending ? '上一次补资料还没确认结果：先在页面顶部处理' : null));
  // 与记方案同一套「结果待确认」（Codex 审查）：本机先记下编号与内容再发；回复丢了不当成没提交，在页面顶部查回、原样重提或确认作废
  const send = async () => {
    setBusy(true);
    const key = uuid();
    try {
      const body = {
        clientKey: key,
        expectedUpdatedAt: r.updatedAt,
        ...head,
        contactName: head.contactName.trim(),
        budgetProject: head.budgetProject.trim(),
        deliveryAddress: head.deliveryAddress.trim(),
        note: head.note.trim(),
        remark: remark.trim(),
        lines: kept.map((x) => (x.custom ? { id: x.line.id, ...customItemBody(x.custom) } : { id: x.line.id, qtyMilli: parseQty(x.qty) })),
      };
      const next = await sendErpOp<MallRequest>({
        key,
        type: 'mall_resubmit',
        method: 'PUT',
        url: `/api/erp/shop/requests/${r.id}/resubmit`,
        body,
        summary: `补资料重提 · ${r.docNo}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      void qc.invalidateQueries({ queryKey: ['shop'] });
      toast({ tone: 'success', title: '已补好资料、重新提交', body: `单号不变：${next.docNo}` });
      setOpen(false);
      onDone(next);
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '补资料结果待确认', body: '回复没收到，可能已经提交：记录留在本机，请在页面顶部查回、原样重提或确认作废' });
        void qc.invalidateQueries({ queryKey: ['shop'] });
        setOpen(false);
      } else toast({ tone: 'error', title: '没有提交', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Notice
        tone="warning"
        title="这张单被退回了：照退回原因补好资料，在原单上重新提交（单号不变）"
        action={
          <Button variant="primary" size="sm" onClick={() => setOpen(true)} data-testid="shop-resubmit-open">
            在原单补资料
          </Button>
        }
        data-testid="shop-resubmit-notice"
      >
        退回原因：{r.reason ?? '（没写原因）'}
      </Notice>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`补资料 · ${r.docNo}`}
        width="max-w-3xl"
        footer={
          <>
            {problem && <span className="mr-auto text-[12.5px] text-clay">{problem}</span>}
            <Button variant="ghost" onClick={() => setOpen(false)}>
              先不提交
            </Button>
            <Button variant="primary" loading={busy} disabled={!!problem || uploading > 0} onClick={() => void send()} data-testid="shop-resubmit-send">
              补好了，重新提交
            </Button>
          </>
        }
      >
        <div className="space-y-4" data-testid="shop-resubmit">
          <div className="rounded-xl bg-clay-soft/60 px-3.5 py-2.5 text-[13px] text-ink ring-1 ring-clay/20">
            <span className="font-semibold">退回原因：</span>
            {r.reason ?? '（没写原因）'}
          </div>
          {items.map((x, i) => (
            <Card key={x.line.id} className={cn('space-y-3 p-4', !x.keep && 'opacity-60')}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[14px] font-bold text-ink">
                  第 {x.line.lineNo} 行 · {x.line.name}
                  {x.line.skuCode && <span className="ml-1.5 text-[12px] font-normal text-ink-3">商城选品（只能改数量）</span>}
                </p>
                <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                  <input type="checkbox" className="size-4 accent-pine" checked={!x.keep} onChange={(e) => setItems(items.map((y, j) => (j === i ? { ...y, keep: !e.target.checked } : y)))} />
                  这一行不要了
                </label>
              </div>
              {x.keep &&
                (x.custom ? (
                  <CustomItemFields
                    s={x.custom}
                    set={(c) => setItems((prev) => prev.map((y, j) => (j === i && y.custom ? { ...y, custom: typeof c === 'function' ? c(y.custom) : c } : y)))}
                    categories={categories}
                    idPrefix={`rs${x.line.id}`}
                    onUploading={(b) => setUploading((n) => Math.max(0, n + (b ? 1 : -1)))}
                  />
                ) : (
                  <Field label={`数量（${x.line.unit}）`} htmlFor={`rs-qty-${x.line.id}`}>
                    <Input
                      id={`rs-qty-${x.line.id}`}
                      inputMode="decimal"
                      className="w-36"
                      value={x.qty}
                      onChange={(e) => setItems(items.map((y, j) => (j === i ? { ...y, qty: e.target.value } : y)))}
                    />
                  </Field>
                ))}
            </Card>
          ))}
          <Card className="grid gap-3 p-4 sm:grid-cols-2">
            <Field label="经办人" htmlFor="rs-contact">
              <Input id="rs-contact" maxLength={40} value={head.contactName} onChange={(e) => setHead({ ...head, contactName: e.target.value })} />
            </Field>
            <Field label="预算项目 / 费用归属" htmlFor="rs-budget">
              <Input id="rs-budget" maxLength={80} value={head.budgetProject} onChange={(e) => setHead({ ...head, budgetProject: e.target.value })} />
            </Field>
            <Field label="期望到货" htmlFor="rs-need">
              <Input id="rs-need" type="date" value={head.needBy} onChange={(e) => setHead({ ...head, needBy: e.target.value })} />
            </Field>
            <Field label="收货地点" htmlFor="rs-addr">
              <Input id="rs-addr" maxLength={120} value={head.deliveryAddress} onChange={(e) => setHead({ ...head, deliveryAddress: e.target.value })} />
            </Field>
            <Field label="优先级" htmlFor="rs-pri">
              <Select id="rs-pri" value={head.priority} onChange={(e) => setHead({ ...head, priority: e.target.value as RequestPriority })}>
                {REQUEST_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="备注" htmlFor="rs-note">
              <Input id="rs-note" maxLength={500} value={head.note} onChange={(e) => setHead({ ...head, note: e.target.value })} />
            </Field>
            <Field label="补了什么（给审核的人看）" htmlFor="rs-remark" className="sm:col-span-2">
              <Input id="rs-remark" maxLength={200} value={remark} placeholder="例如：补了尺寸和设计稿，数量改成 100" onChange={(e) => setRemark(e.target.value)} data-testid="shop-resubmit-remark" />
            </Field>
          </Card>
        </div>
      </Dialog>
    </>
  );
}

// ───────────────────────── 接单与成交方案 ─────────────────────────

const TAX_OPTIONS = [1300, 900, 600, 300, 100, 0];

/** 方案卡片：部门看供应商、交期、说明；采购另看价格、截图、内部备注 */
function QuoteCard({ q, line, r, onChange }: { q: MallQuote; line: MallRequestLine | undefined; r: MallRequest; onChange: (next: MallRequest) => void }) {
  const toast = useToast();
  const session = useSession();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [wechat, setWechat] = useState<string | null>(null);
  // 本机还有一笔选定 / 撤下没确认结果（Codex 审查）：先在页面顶部查回、原样重提或确认作废，不另发新的（晚到的旧确认不会盖掉之后的改选）
  const pending = useErpRecorded(['mall_quote_act']).some((op) => op.staffId === session.staff.id);
  const act = async (url: string, body: Record<string, unknown>, ok: string) => {
    if (pending) {
      toast({ tone: 'info', title: '上一笔方案操作还没确认结果', body: '请先在页面顶部查回、原样重提或确认作废' });
      return;
    }
    setBusy(true);
    const key = uuid();
    try {
      const next = await sendErpOp<MallRequest>({
        key,
        type: 'mall_quote_act',
        method: 'POST',
        url,
        body: { ...body, clientKey: key },
        summary: `${ok.replace(/^已/, '')} · ${r.docNo} · ${q.supplierName}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      onChange(next);
      toast({ tone: 'success', title: ok });
      setWechat(null);
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '结果待确认', body: '回复没收到，可能已经生效：记录留在本机，请在页面顶部查回、原样重提或确认作废' });
        void qc.invalidateQueries({ queryKey: ['shop'] });
      } else toast({ tone: 'error', title: '没有成功', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const selected = q.status === 'selected';
  const total = q.unitPriceCents !== null && line ? Math.round((q.unitPriceCents * line.qtyMilli) / 1000) + (q.freightCents ?? 0) : null;
  return (
    <li className={cn('space-y-2 rounded-2xl p-3.5 ring-1', selected ? 'bg-pine-tint ring-pine/40' : 'bg-card ring-line')} data-testid={`shop-quote-${q.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-[14px] font-bold text-ink">
            {q.supplierName}
            {q.recommended && (
              <Badge tone="yuzu" icon={<Star className="size-3" />}>
                采购推荐
              </Badge>
            )}
            {selected && <Badge tone="pine">{q.selectedMode === 'wechat' ? '已在微信确认' : '部门已确认'}</Badge>}
          </p>
          <p className="text-[12.5px] text-ink-3">
            交期约 {q.leadDays} 天{q.validUntil && ` · 报价有效至 ${q.validUntil}`} · {q.createdByName} 记
          </p>
        </div>
        {r.can.seePrices && q.unitPriceCents !== null && (
          <div className="text-right">
            <p className="text-[16px] font-bold text-clay">
              {formatYuan(q.unitPriceCents)}
              <span className="text-[12px] font-normal text-ink-3">
                {' '}
                / {line?.unit ?? '单位'}（含税 {(q.taxRateBp ?? 0) / 100}%）
              </span>
            </p>
            <p className="text-[12px] text-ink-3">
              运费 {formatYuan(q.freightCents ?? 0)}
              {total !== null && ` · 合计约 ${formatYuan(total)}`}
            </p>
          </div>
        )}
      </div>
      {q.planNote && <p className="text-[13px] text-ink-2">{q.planNote}</p>}
      {r.can.seePrices && q.internalNote && <p className="text-[12.5px] text-ink-3">内部备注：{q.internalNote}</p>}
      {r.can.seePrices && q.imageIds.length > 0 && <ImageThumbs images={q.imageIds.map(quoteImageRef)} />}
      {selected && q.selectedNote && <p className="text-[12.5px] text-ink-3">确认说明：{q.selectedNote}</p>}
      {!selected && (
        <div className="flex flex-wrap justify-end gap-2">
          {r.can.confirmPlan && (
            <Button
              size="sm"
              variant="primary"
              icon={<Check className="size-3.5" />}
              loading={busy}
              onClick={() => void act(`/api/erp/shop/quotes/${q.id}/select`, { mode: 'dept' }, '已确认这个方案')}
              data-testid={`shop-quote-confirm-${q.id}`}
            >
              就用这个方案
            </Button>
          )}
          {r.can.source && (
            <>
              <Button size="sm" variant="secondary" icon={<MessageCircle className="size-3.5" />} onClick={() => setWechat('')} data-testid={`shop-quote-wechat-${q.id}`}>
                部门已在微信确认
              </Button>
              <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} loading={busy} onClick={() => void act(`/api/erp/shop/quotes/${q.id}/withdraw`, {}, '方案已撤下')}>
                撤下
              </Button>
            </>
          )}
        </div>
      )}
      {wechat !== null && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl bg-paper-2/60 p-2.5">
          <Field label="谁、什么时候在微信上确认的" htmlFor={`wx-${q.id}`} className="min-w-[220px] flex-1">
            <Input id={`wx-${q.id}`} maxLength={200} value={wechat} placeholder="例如：品牌部王经理 11-27 上午确认" onChange={(e) => setWechat(e.target.value)} />
          </Field>
          <Button
            size="sm"
            variant="primary"
            disabled={!wechat.trim()}
            loading={busy}
            onClick={() => void act(`/api/erp/shop/quotes/${q.id}/select`, { mode: 'wechat', note: wechat.trim() }, '已记下微信确认')}
          >
            记下
          </Button>
        </div>
      )}
    </li>
  );
}

interface QuoteForm {
  lineId: number;
  supplierId: string;
  supplierName: string;
  price: string;
  taxRateBp: number;
  freight: string;
  leadDays: string;
  validUntil: string;
  planNote: string;
  internalNote: string;
  images: ImageRef[];
  recommended: boolean;
}

function QuoteDialog({ r, onClose, onDone }: { r: MallRequest; onClose: () => void; onDone: (next: MallRequest) => void }) {
  const toast = useToast();
  const session = useSession();
  const qc = useQueryClient();
  // 本机还有一笔方案没确认结果：先处理那一笔，不另开新的
  const pending = useErpRecorded(['mall_quote']).filter((op) => op.staffId === session.staff.id).length > 0;
  const suppliers = useQuery({ queryKey: ['shop', 'pilot-suppliers'], queryFn: () => api.get<{ id: number; name: string; active: boolean }[]>('/api/inventory/suppliers') });
  const [key] = useState(() => uuid());
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [f, setF] = useState<QuoteForm>({
    lineId: r.lines[0]!.id,
    supplierId: '',
    supplierName: '',
    price: '',
    taxRateBp: 1300,
    freight: '0',
    leadDays: '7',
    validUntil: '',
    planNote: '',
    internalNote: '',
    images: [],
    recommended: !r.quotes.some((q) => q.recommended),
  });
  const price = parseYuan(f.price);
  const freight = f.freight ? parseYuan(f.freight) : 0;
  const lead = Number(f.leadDays);
  const problem =
    !f.supplierId && !f.supplierName.trim()
      ? '请选供应商，或写上还没建档的供应商名称'
      : price === null
        ? '请填写含税单价'
        : freight === null
          ? '运费格式不对'
          : !Number.isInteger(lead) || lead < 0 || lead > 365
            ? '交期写 0–365 天'
            : null;
  // 「结果待确认」（Codex 审查；操作类型 mall_quote，采购自己就能查回、作废）：本机先记下编号与内容再发；回复丢了在页面顶部查回、原样重提或确认作废，不会记成两条
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        clientKey: key,
        lineId: f.lineId,
        supplierId: f.supplierId ? Number(f.supplierId) : null,
        supplierName: f.supplierName.trim(),
        unitPriceCents: price,
        taxRateBp: f.taxRateBp,
        freightCents: freight,
        leadDays: lead,
        validUntil: f.validUntil || null,
        planNote: f.planNote.trim(),
        internalNote: f.internalNote.trim(),
        imageIds: f.images.map((i) => i.id),
        recommended: f.recommended,
      };
      const next = await sendErpOp<MallRequest>({
        key,
        type: 'mall_quote',
        method: 'POST',
        url: `/api/erp/shop/requests/${r.id}/quotes`,
        body,
        summary: `成交方案 · ${r.docNo} · ${f.supplierName.trim() || (suppliers.data ?? []).find((s) => String(s.id) === f.supplierId)?.name || '供应商'}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: '方案已记下', body: '部门在「我的采购需求」里看得到，可以直接确认' });
      onDone(next);
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '方案结果待确认', body: '回复没收到，记录留在本机：请在页面顶部查回、原样重提或确认作废，别另记一条' });
        void qc.invalidateQueries({ queryKey: ['shop'] });
        onClose();
      } else toast({ tone: 'error', title: '方案没有记下', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const line = r.lines.find((l) => l.id === f.lineId);
  return (
    <Dialog
      open
      onClose={onClose}
      title="记成交方案"
      description="在微信上跟供应商谈好以后，把最后定的供应商、价格、交期记在这里；部门看得到供应商、交期与方案说明，看不到价格与截图。"
      width="max-w-2xl"
      footer={
        <>
          {(pending ? '上一笔还没确认结果：先在页面顶部处理' : problem) && <span className="mr-auto text-[12.5px] text-clay">{pending ? '上一笔还没确认结果：先在页面顶部处理' : problem}</span>}
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem || uploading || pending} onClick={() => void save()} data-testid="shop-quote-save">
            记下方案
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-testid="shop-quote-form">
        {r.lines.length > 1 && (
          <Field label="哪一行" htmlFor="qf-line" className="sm:col-span-2">
            <Select id="qf-line" value={f.lineId} onChange={(e) => setF({ ...f, lineId: Number(e.target.value) })}>
              {r.lines.map((l) => (
                <option key={l.id} value={l.id}>
                  第 {l.lineNo} 行 · {l.name}（{formatQty(l.qtyMilli)} {l.unit}）
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="供应商（已建档）" htmlFor="qf-sup">
          <Select id="qf-sup" value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
            <option value="">还没建档，写名称</option>
            {(suppliers.data ?? [])
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="供应商名称（没建档的）" htmlFor="qf-supname">
          <Input id="qf-supname" maxLength={80} disabled={!!f.supplierId} value={f.supplierName} onChange={(e) => setF({ ...f, supplierName: e.target.value })} />
        </Field>
        <Field label={`含税单价（元 / ${line?.unit ?? '单位'}）`} htmlFor="qf-price">
          <Input id="qf-price" inputMode="decimal" value={f.price} invalid={!!f.price && price === null} onChange={(e) => setF({ ...f, price: e.target.value })} />
        </Field>
        <Field label="税率" htmlFor="qf-tax">
          <Select id="qf-tax" value={f.taxRateBp} onChange={(e) => setF({ ...f, taxRateBp: Number(e.target.value) })}>
            {TAX_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t / 100}%
              </option>
            ))}
          </Select>
        </Field>
        <Field label="运费（元，这一单）" htmlFor="qf-freight">
          <Input id="qf-freight" inputMode="decimal" value={f.freight} onChange={(e) => setF({ ...f, freight: e.target.value })} />
        </Field>
        <Field label="交期（天）" htmlFor="qf-lead">
          <Input id="qf-lead" inputMode="numeric" value={f.leadDays} onChange={(e) => setF({ ...f, leadDays: e.target.value })} />
        </Field>
        <Field label="报价有效至（选填）" htmlFor="qf-valid">
          <Input id="qf-valid" type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-[13.5px] text-ink">
          <input type="checkbox" className="size-4 accent-pine" checked={f.recommended} onChange={(e) => setF({ ...f, recommended: e.target.checked })} />
          推荐这个方案
        </label>
        <Field label="给部门看的方案说明" htmlFor="qf-plan" className="sm:col-span-2" hint="规格、材质、样品安排等，部门照这个确认">
          <Textarea id="qf-plan" rows={2} maxLength={500} value={f.planNote} onChange={(e) => setF({ ...f, planNote: e.target.value })} />
        </Field>
        <Field label="内部备注（只有采购看得到）" htmlFor="qf-internal" className="sm:col-span-2">
          <Textarea id="qf-internal" rows={2} maxLength={500} value={f.internalNote} onChange={(e) => setF({ ...f, internalNote: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-[13px] font-semibold text-ink-2">报价截图、样品照片（只有采购看得到，最多 9 张）</p>
          <ImagePicker value={f.images} onChange={(images) => setF((cur) => ({ ...cur, images }))} max={9} onBusyChange={setUploading} uploadUrl={QUOTE_IMAGES} testId="shop-quote-images" />
        </div>
      </div>
    </Dialog>
  );
}

/** 详情页的「接单与成交方案」：采购接单、记方案；部门确认方案 */
export function SourcingPanel({ r, onChange }: { r: MallRequest; onChange: (next: MallRequest) => void }) {
  const toast = useToast();
  const session = useSession();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  // 接单、放回走「结果待确认」（Codex 审查）：本机还有没确认的一笔时先处理那一笔
  const pending = useErpRecorded(['mall_quote_act']).some((op) => op.staffId === session.staff.id);
  const show = r.can.source || r.quotes.length > 0 || r.sourcingOwner !== null;
  if (!show) return null;
  const claim = async (body: Record<string, boolean>, ok: string) => {
    if (pending) {
      toast({ tone: 'info', title: '上一笔操作还没确认结果', body: '请先在页面顶部查回、原样重提或确认作废' });
      return;
    }
    setBusy(true);
    const key = uuid();
    try {
      const next = await sendErpOp<MallRequest>({
        key,
        type: 'mall_quote_act',
        method: 'POST',
        url: `/api/erp/shop/requests/${r.id}/claim`,
        body: { ...body, clientKey: key },
        summary: `${ok.replace(/^已/, '')} · ${r.docNo}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      onChange(next);
      toast({ tone: 'success', title: ok });
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '结果待确认', body: '回复没收到，可能已经生效：记录留在本机，请在页面顶部查回、原样重提或确认作废' });
        void qc.invalidateQueries({ queryKey: ['shop'] });
      } else toast({ tone: 'error', title: '没有成功', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const byLine = new Map<number, MallQuote[]>();
  for (const q of r.quotes) byLine.set(q.lineId, [...(byLine.get(q.lineId) ?? []), q]);
  return (
    <Card className="space-y-3 p-4" data-testid="shop-sourcing">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[14px] font-bold text-ink">供应链跟进与成交方案</p>
          <p className="text-[12.5px] text-ink-3" data-testid="shop-sourcing-owner">
            {r.sourcingOwner ? `${r.sourcingOwner.name} 在跟进` : '还没有采购接单'}
            {!r.can.seePrices && r.quotes.length > 0 && ' · 价格由采购把关，这里只列供应商、交期与方案说明'}
          </p>
        </div>
        {r.can.source && (
          <div className="flex flex-wrap gap-2">
            {!r.sourcingOwner && (
              <Button size="sm" variant="secondary" icon={<Hand className="size-3.5" />} loading={busy} onClick={() => void claim({}, '已接单')} data-testid="shop-claim">
                接单
              </Button>
            )}
            {r.sourcingOwner && (
              <Button size="sm" variant="ghost" loading={busy} onClick={() => void claim({ release: true }, '已放回需求池')}>
                放回需求池
              </Button>
            )}
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)} data-testid="shop-quote-add">
              记成交方案
            </Button>
          </div>
        )}
      </div>
      {r.quotes.length === 0 ? (
        <p className="text-[13px] text-ink-3">{r.can.source ? '在微信上跟供应商谈好以后，把定下的供应商、价格、交期记在这里，再请部门确认。' : '采购找好供应商后，方案会出现在这里，请你确认。'}</p>
      ) : (
        r.lines
          .filter((l) => byLine.has(l.id))
          .map((l) => (
            <div key={l.id} className="space-y-2">
              {r.lines.length > 1 && (
                <p className="text-[13px] font-semibold text-ink-2">
                  第 {l.lineNo} 行 · {l.name}
                </p>
              )}
              <ul className="space-y-2">
                {byLine.get(l.id)!.map((q) => (
                  <QuoteCard key={q.id} q={q} line={l} r={r} onChange={onChange} />
                ))}
              </ul>
            </div>
          ))
      )}
      {adding && <QuoteDialog r={r} onClose={() => setAdding(false)} onDone={onChange} />}
    </Card>
  );
}
