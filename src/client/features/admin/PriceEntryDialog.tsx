// 全品类价目表 第三批（docs/PRICE_CATALOG.md 第 5 节）：单条新增、修改（改价）的表单，与一项的改动记录。
// 校验与服务端同一份（priceEntryProblems）：边填边提示，有问题不能保存。价格按元填，存整数分；
// 「待定价」两个价格都空着（不存 0），服务费按百分比填。改价可以写原因，留痕记经办人、时间、旧价 → 新价。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DISH_SECTIONS,
  MASSAGE_SECTIONS,
  PRICE_CHANGE_LABELS,
  PRICE_GENDER_LABELS,
  PRICE_KIND_LABELS,
  PRICE_SHEET_KINDS,
  PRICE_SHEET_NAMES,
  PRICE_SHEETS,
  PRICE_VENUE_LABELS,
  derivedMainPrice,
  priceChangeLines,
  priceEntryProblems,
  withDerivedPrice,
  type PriceCatalogEntry,
  type PriceChange,
  type PriceGender,
  type PriceKind,
  type PriceMode,
  type PriceSheet,
  type PriceVenue,
} from '@shared/price-catalog';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Field, Input, MoneyInput, Notice, Segmented, Select, Skeleton, Textarea } from '../../components/ui';

/** 表单里的值都是输入框的字符串：金额按元、时长按分钟、时段按「7:30」 */
interface Form {
  sheet: PriceSheet;
  kind: PriceKind;
  name: string;
  code: string;
  section: string;
  category: string;
  unit: string;
  priceMode: PriceMode;
  price: string;
  price2: string;
  ratePercent: string;
  duration: string;
  extraPrice: string;
  extraMinutes: string;
  cap: string;
  units: string;
  rooms: string;
  windowStart: string;
  windowEnd: string;
  venues: PriceVenue[];
  gender: PriceGender | '';
  variants: { label: string; price: string }[];
  orderable: boolean;
  note: string;
  reason: string;
}

const money = (c: number | null) => (c === null ? '' : centsToInput(c));
const intText = (n: number | null) => (n === null ? '' : String(n));
const hm = (m: number | null) => (m === null ? '' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);

function formOf(e: PriceCatalogEntry): Form {
  return {
    sheet: e.sheet,
    kind: e.kind,
    name: e.name,
    code: e.code,
    section: e.section,
    category: e.category,
    unit: e.unit,
    priceMode: e.priceMode,
    price: money(e.priceCents),
    price2: money(e.price2Cents),
    ratePercent: e.rateBp === null ? '' : String(e.rateBp / 100),
    duration: intText(e.durationMinutes),
    extraPrice: money(e.extraPriceCents),
    extraMinutes: intText(e.extraMinutes),
    cap: money(e.capCents),
    units: intText(e.unitsCount),
    rooms: e.roomNumbers.join(' '),
    windowStart: hm(e.windowStart),
    windowEnd: hm(e.windowEnd),
    venues: e.venues,
    gender: e.gender ?? '',
    variants: e.variants.map((v) => ({ label: v.label, price: money(v.priceCents) })),
    orderable: e.orderable,
    note: e.note,
    reason: '',
  };
}

function blankEntry(sheet: PriceSheet): PriceCatalogEntry {
  const kind = PRICE_SHEET_KINDS[sheet][0]!;
  return {
    sheet,
    kind,
    section: sheet === 'massage' ? MASSAGE_SECTIONS[0] : sheet === 'dish' ? DISH_SECTIONS[0] : '',
    category: '',
    code: '',
    name: '',
    priceMode: 'single',
    priceCents: null,
    price2Cents: null,
    rateBp: null,
    unit: '',
    durationMinutes: null,
    extraPriceCents: null,
    extraMinutes: null,
    capCents: null,
    unitsCount: null,
    roomNumbers: [],
    windowStart: null,
    windowEnd: null,
    includesMeal: null,
    venues: [],
    gender: null,
    audience: '',
    content: '',
    highlight: '',
    note: '',
    variants: [],
    orderable: true,
    active: true,
    sourceRow: null,
    sortOrder: 0,
  };
}

/** 填的字符串 → 条目；看不懂的数（不是空、也不是数）记成问题 */
function entryOf(base: PriceCatalogEntry, f: Form): { entry: PriceCatalogEntry; problems: string[] } {
  const problems: string[] = [];
  const cents = (s: string, label: string) => {
    if (!s.trim()) return null;
    const v = parseYuan(s);
    if (v === null) problems.push(`${label}看不懂：按元填，最多两位小数`);
    return v;
  };
  const whole = (s: string, label: string) => {
    if (!s.trim()) return null;
    if (!/^\d+$/.test(s.trim())) problems.push(`${label}要填整数`);
    return Number(s.trim());
  };
  const time = (s: string, label: string) => {
    if (!s.trim()) return null;
    const m = /^(\d{1,2})[:：](\d{2})$/.exec(s.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      problems.push(`${label}照「7:30」这样填`);
      return null;
    }
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const isRate = f.priceMode === 'rate';
  const ratePct = isRate && f.ratePercent.trim() ? Number(f.ratePercent.trim().replace(/%$/, '')) : null;
  if (ratePct !== null && !Number.isFinite(ratePct)) problems.push('比例看不懂：照「10」填，表示 10%');
  const entry: PriceCatalogEntry = {
    ...base,
    sheet: f.sheet,
    kind: f.kind,
    name: f.name.trim(),
    code: f.code.trim(),
    section: f.section.trim(),
    category: f.category.trim(),
    unit: f.unit.trim(),
    priceMode: f.priceMode,
    priceCents: f.priceMode === 'dual' || f.priceMode === 'single' ? cents(f.price, f.priceMode === 'dual' ? '专业价' : '价格') : null,
    price2Cents: f.priceMode === 'dual' ? cents(f.price2, '资深价') : null,
    rateBp: ratePct === null || !Number.isFinite(ratePct) ? null : Math.round(ratePct * 100),
    durationMinutes: whole(f.duration, '时长'),
    extraPriceCents: cents(f.extraPrice, '加钟 / 超时价'),
    extraMinutes: whole(f.extraMinutes, '每次分钟'),
    capCents: cents(f.cap, '封顶价'),
    unitsCount: whole(f.units, '台位 / 间数'),
    roomNumbers: f.rooms.split(/[\s,，、]+/).filter(Boolean),
    windowStart: time(f.windowStart, '开始时刻'),
    windowEnd: time(f.windowEnd, '结束时刻'),
    venues: f.venues,
    gender: f.gender || null,
    variants: base.variants.map((v, i) => ({ ...v, priceCents: cents(f.variants[i]?.price ?? '', `分档「${v.label}」`) })),
    orderable: f.orderable,
    note: f.note.trim(),
  };
  // 主价格由分档推出来的（轰趴房、餐饮包房、客房）按分档重算，与服务端同一个口径
  const derived = withDerivedPrice(entry);
  return { entry: derived, problems: [...problems, ...priceEntryProblems(derived)] };
}

/** 新增（entry 为空，在 setId 这份里加）或修改一项。打开时才挂上、按这一项给 key：每次打开都从这一项现在的值重新填 */
export function PriceEntryDialog({
  open,
  setId,
  entry,
  defaultSheet,
  onClose,
  onSaved,
  onUncertain,
}: {
  open: boolean;
  setId: number;
  entry: PriceCatalogEntry | null;
  defaultSheet: PriceSheet;
  onClose: () => void;
  onSaved: (e: PriceCatalogEntry) => void;
  /** 结果不确定（断网、超时、服务器出错）：这一笔已记在本机，页面上方查回、重提或作废 */
  onUncertain: () => void;
}) {
  const session = useSession();
  const [base, setBase] = useState(() => entry ?? blankEntry(defaultSheet));
  const [form, setForm] = useState(() => formOf(base));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const { entry: next, problems } = entryOf(base, form);
  const creating = !entry;
  const isFee = form.kind === 'service_fee';
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // 每次保存用新的操作编号：先把编号和原请求记在本机并读回核对，记不下就不发（AGENTS.md「结果待确认」）
      const key = uuid();
      const body = { ...next, reason: form.reason.trim(), opKey: key };
      const saved = await sendErpOp<PriceCatalogEntry>({
        key,
        type: 'price_entry',
        url: creating ? `/api/admin/price-catalog/sets/${setId}/entries` : `/api/admin/price-catalog/entries/${entry.id}`,
        body: creating ? body : { ...body, version: entry.version },
        summary: `${creating ? '新增' : '修改'}「${next.name}」`,
        staffName: session.staff.displayName,
      });
      onSaved(saved);
    } catch (e) {
      if (e instanceof UncertainError) onUncertain();
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const changeSheet = (sheet: PriceSheet) => {
    const b = blankEntry(sheet);
    setBase(b);
    setForm({ ...formOf(b), name: form.name, reason: form.reason });
  };
  const sections: readonly string[] = form.sheet === 'massage' ? MASSAGE_SECTIONS : form.sheet === 'dish' ? DISH_SECTIONS : [];
  const extraLabel = form.sheet === 'entertainment' ? '加钟价' : '超时价';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={creating ? '新增一项' : `修改「${entry.name}」`}
      description={creating ? '新增的项目排在这张表最后；名称在同一个板块 / 餐段、同一个分类里不能重复。' : '改价留痕：记下经办人、时间与旧价 → 新价。'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={problems.length > 0} loading={busy} onClick={() => void save()} data-testid="price-entry-save">
            {creating ? '新增' : '保存'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2" data-testid="price-entry-form">
        {creating && (
          <>
            <Field label="工作表" htmlFor="pe-sheet">
              <Select id="pe-sheet" value={form.sheet} onChange={(e) => changeSheet(e.target.value as PriceSheet)} data-testid="price-entry-sheet">
                {PRICE_SHEETS.map((s) => (
                  <option key={s} value={s}>
                    {PRICE_SHEET_NAMES[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="种类" htmlFor="pe-kind">
              <Select id="pe-kind" value={form.kind} onChange={(e) => set('kind', e.target.value as PriceKind)}>
                {PRICE_SHEET_KINDS[form.sheet].map((k) => (
                  <option key={k} value={k}>
                    {PRICE_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        <Field label="名称" htmlFor="pe-name">
          <Input id="pe-name" data-autofocus value={form.name} maxLength={48} onChange={(e) => set('name', e.target.value)} data-testid="price-entry-name" />
        </Field>
        <Field label="编号" htmlFor="pe-code" hint="表格里的原始编号，可不填">
          <Input id="pe-code" value={form.code} maxLength={12} onChange={(e) => set('code', e.target.value)} />
        </Field>
        {sections.length > 0 ? (
          <Field label={form.sheet === 'massage' ? '板块' : '餐段'} htmlFor="pe-section">
            <Select id="pe-section" value={form.section} onChange={(e) => set('section', e.target.value)} data-testid="price-entry-section">
              {sections.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="类型" htmlFor="pe-section" hint="表格里「类型」一列，可不填">
            <Input id="pe-section" value={form.section} maxLength={20} onChange={(e) => set('section', e.target.value)} />
          </Field>
        )}
        {form.sheet === 'dish' && (
          <Field label="菜品分类" htmlFor="pe-category">
            <Input id="pe-category" value={form.category} maxLength={20} onChange={(e) => set('category', e.target.value)} />
          </Field>
        )}

        {isFee ? (
          <Field label="比例（%）" htmlFor="pe-rate" hint="全场消费加收的比例，10 表示 10%">
            <Input id="pe-rate" inputMode="decimal" value={form.ratePercent} onChange={(e) => set('ratePercent', e.target.value)} data-testid="price-entry-rate" />
          </Field>
        ) : (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-[13px] font-semibold text-ink-2">价格</span>
            <Segmented<PriceMode>
              size="sm"
              className="self-start"
              value={form.priceMode}
              onChange={(v) => set('priceMode', v)}
              ariaLabel="价格形态"
              options={[
                { value: 'single', label: '单价' },
                { value: 'dual', label: '专业 / 资深' },
                { value: 'none', label: '待定价' },
              ]}
            />
            {derivedMainPrice(base) !== undefined && form.priceMode !== 'none' ? (
              <p className="text-[12.5px] text-ink-3" data-testid="price-entry-derived">
                主价格按下面分档的最低价：{next.priceCents === null ? '—' : formatYuan(next.priceCents)}（改分档价，主价格跟着变）
              </p>
            ) : form.priceMode === 'none' ? (
              <p className="text-[12.5px] text-ink-3">没有价格：页面写「待定价」，不存 0 元。{form.sheet === 'dish' ? '待定价的菜不能下单。' : ''}</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <MoneyInput
                  aria-label={form.priceMode === 'dual' ? '专业价' : '价格'}
                  placeholder={form.priceMode === 'dual' ? '专业价' : '价格'}
                  value={form.price}
                  onChange={(e) => set('price', e.target.value)}
                  data-testid="price-entry-price"
                />
                {form.priceMode === 'dual' && (
                  <MoneyInput aria-label="资深价" placeholder="资深价" value={form.price2} onChange={(e) => set('price2', e.target.value)} data-testid="price-entry-price2" />
                )}
                <Input aria-label="单位" placeholder="单位（位、份……）" value={form.unit} maxLength={8} onChange={(e) => set('unit', e.target.value)} />
              </div>
            )}
          </div>
        )}

        {base.variants.length > 0 && (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-[13px] font-semibold text-ink-2">分档价格</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {base.variants.map((v, i) => (
                <label key={i} className="flex items-center gap-2 text-[13px]">
                  <span className="w-28 shrink-0 text-ink-2">
                    {v.label}
                    {v.unit ? `（${v.unit}）` : ''}
                  </span>
                  <MoneyInput
                    aria-label={`分档「${v.label}」的价格`}
                    value={form.variants[i]?.price ?? ''}
                    onChange={(e) =>
                      set(
                        'variants',
                        form.variants.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)),
                      )
                    }
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {!isFee && (
          <Field label={form.sheet === 'massage' ? '时长（分钟）' : '含时长（分钟）'} htmlFor="pe-duration" hint={form.sheet === 'massage' ? undefined : '基础价含多少分钟（2 小时填 120）'}>
            <Input id="pe-duration" inputMode="numeric" value={form.duration} onChange={(e) => set('duration', e.target.value)} />
          </Field>
        )}
        {(form.sheet === 'entertainment' || form.sheet === 'room') && (
          <>
            <Field label={extraLabel} htmlFor="pe-extra">
              <div className="grid grid-cols-2 gap-2">
                <MoneyInput id="pe-extra" value={form.extraPrice} onChange={(e) => set('extraPrice', e.target.value)} data-testid="price-entry-extra" />
                <Input aria-label="每次多少分钟" placeholder="每次分钟（60）" inputMode="numeric" value={form.extraMinutes} onChange={(e) => set('extraMinutes', e.target.value)} />
              </div>
            </Field>
            <Field label={form.sheet === 'entertainment' ? '台位数' : '总间数'} htmlFor="pe-units">
              <Input id="pe-units" inputMode="numeric" value={form.units} onChange={(e) => set('units', e.target.value)} />
            </Field>
          </>
        )}
        {form.sheet === 'room' && (
          <>
            <Field label="封顶价" htmlFor="pe-cap">
              <MoneyInput id="pe-cap" value={form.cap} onChange={(e) => set('cap', e.target.value)} />
            </Field>
            <Field label="房号" htmlFor="pe-rooms" hint="空格隔开：S301 S302 S303">
              <Input id="pe-rooms" value={form.rooms} onChange={(e) => set('rooms', e.target.value)} />
            </Field>
          </>
        )}
        {form.sheet === 'store' && !isFee && form.kind !== 'ticket' && (
          <Field label="时段" htmlFor="pe-ws" hint="跨零点的结束早于开始，如 21:00 – 11:00">
            <div className="grid grid-cols-2 gap-2">
              <Input id="pe-ws" placeholder="开始 7:30" value={form.windowStart} onChange={(e) => set('windowStart', e.target.value)} />
              <Input aria-label="结束时刻" placeholder="结束 10:00" value={form.windowEnd} onChange={(e) => set('windowEnd', e.target.value)} />
            </div>
          </Field>
        )}
        {form.sheet === 'massage' && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-ink-2">适用房型</span>
              <div className="flex flex-wrap gap-3 text-[13px]">
                {(Object.keys(PRICE_VENUE_LABELS) as PriceVenue[]).map((v) => (
                  <label key={v} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={form.venues.includes(v)} onChange={(e) => set('venues', e.target.checked ? [...form.venues, v] : form.venues.filter((x) => x !== v))} />
                    {PRICE_VENUE_LABELS[v]}
                  </label>
                ))}
              </div>
            </div>
            <Field label="适用性别" htmlFor="pe-gender">
              <Select id="pe-gender" value={form.gender} onChange={(e) => set('gender', e.target.value as PriceGender | '')}>
                <option value="">不限</option>
                {(Object.keys(PRICE_GENDER_LABELS) as PriceGender[]).map((g) => (
                  <option key={g} value={g}>
                    {PRICE_GENDER_LABELS[g]}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        {!isFee && (
          <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-2 sm:col-span-2">
            <input type="checkbox" checked={form.orderable} onChange={(e) => set('orderable', e.target.checked)} data-testid="price-entry-orderable" />
            可以下单
          </label>
        )}
        <Field label="备注" htmlFor="pe-note" className="sm:col-span-2">
          <Textarea id="pe-note" rows={2} value={form.note} maxLength={400} onChange={(e) => set('note', e.target.value)} />
        </Field>
        <Field label={creating ? '原因（可不填）' : '改动原因（可不填）'} htmlFor="pe-reason" className="sm:col-span-2" hint="会记在改动记录里">
          <Input id="pe-reason" value={form.reason} maxLength={200} onChange={(e) => set('reason', e.target.value)} data-testid="price-entry-reason" />
        </Field>
      </div>
      {problems.length > 0 && (
        <ul className="mt-4 space-y-0.5 rounded-lg border border-clay/40 bg-clay-soft/30 px-3 py-2 text-[12.5px] text-clay" data-testid="price-entry-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && <Notice tone="error" title={error} className="mt-4" />}
    </Dialog>
  );
}

/** 改了什么（「标签 旧 → 新」一行一个） */
export function ChangeLines({ change }: { change: PriceChange }) {
  const lines = priceChangeLines(change.before, change.after, formatYuan);
  if (change.action === 'deactivate' || change.action === 'reactivate') return <span className="text-ink-3">{PRICE_CHANGE_LABELS[change.action]}</span>;
  if (lines.length === 0) return <span className="text-ink-3">没有改动</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {lines.map((l) => (
        <span key={l.label} data-testid="price-change-line">
          <span className="text-ink-3">{l.label}：</span>
          {change.before ? (
            <>
              <span className="text-ink-3 line-through decoration-ink-4">{l.from}</span>
              <span className="mx-1 text-ink-4">→</span>
            </>
          ) : null}
          <span className="font-semibold">{l.to}</span>
        </span>
      ))}
    </span>
  );
}

/** 一项的改动记录 */
export function PriceEntryHistory({ setId, entry, onClose }: { setId: number; entry: PriceCatalogEntry | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['admin', 'price-catalog', 'changes', setId, entry?.id ?? 0],
    queryFn: () => api.get<PriceChange[]>(`/api/admin/price-catalog/sets/${setId}/changes?entryId=${entry!.id}`),
    enabled: !!entry,
  });
  return (
    <Dialog open={!!entry} onClose={onClose} title={entry ? `「${entry.name}」的改动记录` : ''} width="max-w-xl">
      {q.isPending ? (
        <Skeleton className="h-24" />
      ) : q.isError ? (
        <LoadFailed title="改动记录取不回来" onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <p className="text-[13px] text-ink-3">还没有改动：价格照导入时的表格。</p>
      ) : (
        <ul className="divide-y divide-line/70 text-[13px]" data-testid="price-entry-history">
          {q.data.map((c) => (
            <li key={c.id} className="py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
                <Badge tone={c.priceChanged ? 'ember' : 'neutral'}>{PRICE_CHANGE_LABELS[c.action]}</Badge>
                {c.staffName} · {formatDateTime(c.createdAt)}
                {c.reason && <span>· 原因：{c.reason}</span>}
              </div>
              <div className="mt-1">
                <ChangeLines change={c} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
