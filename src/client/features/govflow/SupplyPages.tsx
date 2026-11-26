// 业财法 P02（docs/APPROVAL_V4.md 第 6 节）：供应商库与 SKU。
//   /oa/gov?box=suppliers       供应商库：列表、建档、集团物料（供应链负责人 / 店主）
//   /oa/gov/suppliers/:id       供应商详情：资料、资质缺什么、提交入库、变更、SKU 与协议价版本、SKU 批量提报
// 董事长批 SKU 的差异摘要（异常的逐个给结论）在事项详情里（SkuBatchReviewPanel）。

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Plus } from 'lucide-react';
import { GF_DOC_TYPE_LABELS, type GfDocDetail } from '@shared/govflow';
import {
  QUALIFICATION_KINDS,
  QUALIFICATION_LABELS,
  SKU_ABNORMAL_LABELS,
  SKU_STATUS_LABELS,
  SUPPLIER_STATUS_LABELS,
  SUPPLY_CATEGORIES,
  SUPPLY_CATEGORY_LABELS,
  type GfMaterial,
  type GfSkuView,
  type GfSupplierView,
  type Qualification,
  type QualificationKind,
  type SkuBatchReview,
  type SupplyCategory,
} from '@shared/govflow-supply';
import { api, errorMessage } from '../../lib/api';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Select, Skeleton, Textarea } from '../../components/ui';
import { yuanToCents } from './money';

const STATUS_TONE = { pending: 'neutral', reviewing: 'lake', active: 'moss', disabled: 'ember', exited: 'ink' } as const;

export function SupplierList() {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [materials, setMaterials] = useState(false);
  const list = useQuery({ queryKey: ['gf', 'suppliers', q], queryFn: () => api.get<GfSupplierView[]>(`/api/gf/suppliers${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  return (
    <div className="space-y-3" data-testid="gf-suppliers">
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1" placeholder="名称、统一社会信用代码或编号" value={q} onChange={(e) => setQ(e.target.value)} data-testid="gf-supplier-search" />
        <Button size="sm" variant="secondary" onClick={() => setMaterials(true)}>
          集团物料
        </Button>
        <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="gf-supplier-new">
          建档
        </Button>
      </div>
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.isError && !list.data ? (
        <LoadFailed title="供应商没有取回来" onRetry={() => list.refetch()} retrying={list.isFetching} />
      ) : !list.data.length ? (
        <EmptyState art="calm" title="还没有供应商" />
      ) : (
        <Card className="divide-y divide-line p-0">
          {list.data.map((s) => (
            <Link key={s.id} to={`/oa/gov/suppliers/${s.id}`} className="tap relative flex items-center gap-3 px-4 py-3 hover:bg-paper" data-testid={`gf-supplier-${s.id}`}>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={STATUS_TONE[s.status]}>{SUPPLIER_STATUS_LABELS[s.status]}</Badge>
                  {s.legacy && <Badge tone="ember">历史迁移</Badge>}
                  {s.pendingChangeDocId && <Badge tone="lake">变更审核中</Badge>}
                  <span className="text-[15px] font-semibold text-ink">{s.name}</span>
                </span>
                <span className="num block text-[13px] text-ink-3">
                  {s.supplierNo} · {s.creditCode} · {s.categories.map((c) => SUPPLY_CATEGORY_LABELS[c]).join('、')} · 有效 SKU {s.skuCount}
                </span>
              </span>
            </Link>
          ))}
        </Card>
      )}
      {creating && <SupplierDialog onClose={() => setCreating(false)} />}
      {materials && <MaterialsDialog onClose={() => setMaterials(false)} />}
    </div>
  );
}

interface SupplierForm {
  name: string;
  creditCode: string;
  categories: SupplyCategory[];
  contact: string;
  phone: string;
  address: string;
  bankName: string;
  bankAccount: string;
  accountName: string;
  qualifications: Qualification[];
  note: string;
}
const emptyForm = (): SupplierForm => ({
  name: '',
  creditCode: '',
  categories: ['general'],
  contact: '',
  phone: '',
  address: '',
  bankName: '',
  bankAccount: '',
  accountName: '',
  qualifications: [],
  note: '',
});

function SupplierFormFields({ f, set }: { f: SupplierForm; set: (f: SupplierForm) => void }) {
  const text = (k: keyof SupplierForm, label: string, extra: { mono?: boolean; testId?: string } = {}) => (
    <Field label={label}>
      <Input value={f[k] as string} onChange={(e) => set({ ...f, [k]: e.target.value })} className={cn(extra.mono && 'num')} data-testid={extra.testId} />
    </Field>
  );
  const qual = (kind: QualificationKind) => f.qualifications.find((q) => q.kind === kind);
  const setQual = (kind: QualificationKind, patch: Partial<Qualification>) => {
    const cur = qual(kind) ?? { kind, no: '', expiresOn: null };
    const next = { ...cur, ...patch };
    set({ ...f, qualifications: [...f.qualifications.filter((q) => q.kind !== kind), ...(next.no ? [next] : [])] });
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {text('name', '主体名称', { testId: 'gf-sup-name' })}
      {text('creditCode', '统一社会信用代码', { mono: true, testId: 'gf-sup-credit' })}
      <Field label="供应品类" className="sm:col-span-2">
        <div className="flex flex-wrap gap-1.5">
          {SUPPLY_CATEGORIES.map((c) => {
            const on = f.categories.includes(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => set({ ...f, categories: on ? f.categories.filter((x) => x !== c) : [...f.categories, c] })}
                className={cn('tap relative h-8 rounded-full border px-3 text-[13px] font-semibold', on ? 'border-pine bg-pine text-paper' : 'border-line text-ink-2')}
              >
                {SUPPLY_CATEGORY_LABELS[c]}
              </button>
            );
          })}
        </div>
      </Field>
      {text('contact', '联系人')}
      {text('phone', '电话')}
      {text('bankName', '开户行')}
      {text('bankAccount', '收款账号', { mono: true })}
      {text('accountName', '账户名')}
      {text('address', '地址')}
      <Field label="资质（证照编号与到期日，长期有效不填日期）" className="sm:col-span-2">
        <div className="space-y-1.5">
          {QUALIFICATION_KINDS.map((k) => (
            <div key={k} className="grid grid-cols-[1fr_1fr_9rem] items-center gap-2">
              <span className="text-[13px] text-ink-2">{QUALIFICATION_LABELS[k]}</span>
              <Input value={qual(k)?.no ?? ''} onChange={(e) => setQual(k, { no: e.target.value })} placeholder="编号" data-testid={`gf-qual-${k}`} />
              <Input type="date" value={qual(k)?.expiresOn ?? ''} onChange={(e) => setQual(k, { expiresOn: e.target.value || null })} />
            </div>
          ))}
        </div>
      </Field>
    </div>
  );
}

function SupplierDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const [f, setF] = useState(emptyForm);
  const m = useMutation({
    mutationFn: () => api.post<GfSupplierView>('/api/gf/suppliers', { clientKey, ...f }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['gf', 'suppliers'] });
      navigate(`/oa/gov/suppliers/${s.id}`);
    },
    onError: (e) => toast({ tone: 'error', title: '没有建档', body: errorMessage(e) }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title="供应商建档"
      description="按统一社会信用代码查重；建档后是「待准入」，资料齐了提交入库（供应链负责人 → 董事长）"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!f.name.trim() || !f.creditCode.trim()} onClick={() => m.mutate()} data-testid="gf-sup-save">
            建档
          </Button>
        </>
      }
    >
      <SupplierFormFields f={f} set={setF} />
    </Dialog>
  );
}

function MaterialsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['gf', 'materials'], queryFn: () => api.get<GfMaterial[]>('/api/gf/materials') });
  const [form, setForm] = useState({ code: '', name: '', category: 'general' as SupplyCategory, unit: '', core: false });
  const m = useMutation({
    mutationFn: () => api.post('/api/gf/materials', form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gf', 'materials'] });
      setForm({ ...form, code: '', name: '' });
    },
    onError: (e) => toast({ tone: 'error', title: '没有加上', body: errorMessage(e) }),
  });
  return (
    <Dialog open onClose={onClose} width="max-w-2xl" title="集团物料" description="SKU 都要映射到一个集团物料；核心品类的 SKU 提报会单独列出、加内控">
      <div className="grid gap-2 sm:grid-cols-5">
        <Input placeholder="编码" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <Input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as SupplyCategory })}>
          {SUPPLY_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {SUPPLY_CATEGORY_LABELS[c]}
            </option>
          ))}
        </Select>
        <Input placeholder="单位" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <input type="checkbox" checked={form.core} onChange={(e) => setForm({ ...form, core: e.target.checked })} />
          核心品类
        </label>
      </div>
      <Button className="mt-2" size="sm" loading={m.isPending} disabled={!form.code || !form.name || !form.unit} onClick={() => m.mutate()}>
        加上（供应链负责人、店主）
      </Button>
      <ul className="mt-3 divide-y divide-line text-[14px]">
        {(q.data ?? []).map((x) => (
          <li key={x.id} className="flex gap-2 py-1.5">
            <span className="num w-32 text-ink-3">{x.code}</span>
            <span className="flex-1 text-ink">{x.name}</span>
            <span className="text-ink-3">{SUPPLY_CATEGORY_LABELS[x.category]}</span>
            {x.core && <Badge tone="clay">核心</Badge>}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function SupplierDetailPage({ id }: { id: number }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['gf', 'supplier', id],
    queryFn: () => api.get<{ supplier: GfSupplierView; skus: GfSkuView[]; versions: { version: number; docId: number | null; createdAt: string }[] }>(`/api/gf/suppliers/${id}`),
  });
  const [changing, setChanging] = useState(false);
  const [batch, setBatch] = useState(false);
  const [price, setPrice] = useState<GfSkuView | null>(null);
  const admit = useMutation({
    mutationFn: () => api.post<{ docId: number }>(`/api/gf/suppliers/${id}/admit`, { clientKey: uuid() }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['gf'] });
      navigate(`/oa/gov/${r.docId}`);
    },
    onError: (e) => toast({ tone: 'error', title: '没有提交', body: errorMessage(e) }),
  });
  if (q.isPending) return <Skeleton className="m-3 h-64" />;
  if (q.isError && !q.data) return <LoadFailed title="供应商没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const { supplier: s, skus, versions } = q.data;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7" data-testid="gf-supplier-detail">
      <Link to="/oa/gov?box=suppliers" className="flex items-center gap-1 text-[14px] font-semibold text-pine">
        <ChevronLeft className="size-4" />
        供应商库
      </Link>
      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[s.status]}>
            <span data-testid="gf-supplier-status">{SUPPLIER_STATUS_LABELS[s.status]}</span>
          </Badge>
          {s.legacy && <Badge tone="ember">历史迁移</Badge>}
          <h1 className="text-[18px] font-bold text-ink">{s.name}</h1>
          <span className="num ml-auto text-[13px] text-ink-3">
            {s.supplierNo} · 第 {s.version} 版
          </span>
        </div>
        <dl className="grid gap-x-4 gap-y-1 text-[14px] sm:grid-cols-2">
          <Info label="统一社会信用代码" value={s.creditCode} />
          <Info label="供应品类" value={s.categories.map((c) => SUPPLY_CATEGORY_LABELS[c]).join('、')} />
          <Info label="联系人" value={`${s.contact} ${s.phone}`} />
          <Info label="收款账户" value={`${s.bankName} ${s.bankAccount} ${s.accountName}`} />
        </dl>
        <p className="text-[13px] text-ink-2">资质：{s.qualifications.map((x) => `${QUALIFICATION_LABELS[x.kind]} ${x.no}${x.expiresOn ? `（${x.expiresOn} 到期）` : ''}`).join('；') || '—'}</p>
        {s.missing.length > 0 && (
          <p className="text-[13px] text-clay" data-testid="gf-supplier-missing">
            {s.missing.join('；')}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {s.status === 'pending' && (
            <Button size="sm" loading={admit.isPending} onClick={() => admit.mutate()} data-testid="gf-supplier-admit">
              提交入库审批
            </Button>
          )}
          {s.admissionDocId && (
            <Link to={`/oa/gov/${s.admissionDocId}`} className="flex h-9 items-center px-2 text-[13px] text-pine">
              入库审批单
            </Link>
          )}
          {(s.status === 'active' || s.status === 'disabled') && !s.pendingChangeDocId && (
            <Button size="sm" variant="secondary" onClick={() => setChanging(true)} data-testid="gf-supplier-change">
              发起变更
            </Button>
          )}
          {s.pendingChangeDocId && (
            <Link to={`/oa/gov/${s.pendingChangeDocId}`} className="flex h-9 items-center px-2 text-[13px] text-pine">
              变更审核中（审核期间不按库内简化）
            </Link>
          )}
          {s.status === 'active' && (
            <Button size="sm" variant="secondary" onClick={() => setBatch(true)} data-testid="gf-sku-batch">
              提报 SKU
            </Button>
          )}
        </div>
      </Card>
      <Card className="p-4">
        <h2 className="mb-2 text-[15px] font-bold text-ink">SKU</h2>
        {!skus.length ? (
          <p className="text-[13px] text-ink-3">还没有 SKU</p>
        ) : (
          <ul className="divide-y divide-line">
            {skus.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-2 py-2 text-[14px]">
                <span className="num w-36 text-ink-3">{k.skuCode}</span>
                <span className="min-w-0 flex-1 text-ink">
                  {k.name} {k.spec} · {k.materialName}
                </span>
                <Badge tone={k.status === 'active' ? 'moss' : k.status === 'reviewing' ? 'lake' : 'neutral'}>{SKU_STATUS_LABELS[k.status]}</Badge>
                <Money cents={k.priceCents} className="text-[14px]" />
                <span className="text-[12px] text-ink-3">v{k.priceVersion}</span>
                {k.status === 'active' && !k.pendingChangeDocId && (
                  <Button size="sm" variant="ghost" onClick={() => setPrice(k)}>
                    改协议价
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {versions.length > 0 && (
        <Card className="p-4 text-[13px] text-ink-2">
          版本：
          {versions.map((v) => (
            <span key={v.version} className="mr-3">
              第 {v.version} 版 {formatDateTime(v.createdAt)}
            </span>
          ))}
        </Card>
      )}
      {changing && <ChangeDialog s={s} onClose={() => setChanging(false)} />}
      {batch && <BatchDialog supplierId={s.id} onClose={() => setBatch(false)} />}
      {price && <PriceDialog sku={price} onClose={() => setPrice(null)} />}
    </div>
  );
}

const Info = ({ label, value }: { label: string; value: string }) => (
  <div className="flex gap-2">
    <dt className="shrink-0 text-ink-3">{label}</dt>
    <dd className="num min-w-0 break-all text-ink">{value || '—'}</dd>
  </div>
);

function ChangeDialog({ s, onClose }: { s: GfSupplierView; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const [f, setF] = useState<SupplierForm>({ ...emptyForm(), ...s, bankAccount: s.bankMasked ? '' : s.bankAccount });
  const [reason, setReason] = useState('');
  const changes = Object.fromEntries(
    (Object.keys(f) as (keyof SupplierForm)[])
      .filter((k) => !(k === 'bankAccount' && s.bankMasked && !f.bankAccount))
      .filter((k) => JSON.stringify(f[k]) !== JSON.stringify(s[k as keyof GfSupplierView]))
      .map((k) => [k, f[k]]),
  );
  const m = useMutation({
    mutationFn: () => api.post<{ docId: number }>(`/api/gf/suppliers/${s.id}/change`, { clientKey, reason, changes }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['gf'] });
      navigate(`/oa/gov/${r.docId}`);
    },
    onError: (e) => toast({ tone: 'error', title: '没有发起', body: errorMessage(e) }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title="供应商变更"
      description="主体、税号、收款账户、核心资质走 供应链负责人 → 董事长（知会 CFO、财总）；其他资料供应链负责人审核留痕"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!Object.keys(changes).length || reason.trim().length < 2} onClick={() => m.mutate()}>
            提交变更（改了 {Object.keys(changes).length} 项）
          </Button>
        </>
      }
    >
      <SupplierFormFields f={f} set={setF} />
      <Field label="变更原因" className="mt-3">
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

interface Line {
  materialId: number | '';
  name: string;
  spec: string;
  unit: string;
  price: string;
}

function BatchDialog({ supplierId, onClose }: { supplierId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const mats = useQuery({ queryKey: ['gf', 'materials'], queryFn: () => api.get<GfMaterial[]>('/api/gf/materials') });
  const [lines, setLines] = useState<Line[]>([{ materialId: '', name: '', spec: '', unit: '', price: '' }]);
  const ok = lines.every((l) => l.materialId && l.name.trim() && l.unit.trim() && yuanToCents(l.price) !== null);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ docId: number }>('/api/gf/sku-batches', {
        clientKey,
        supplierId,
        lines: lines.map((l) => ({ materialId: l.materialId, name: l.name, spec: l.spec, unit: l.unit, priceCents: yuanToCents(l.price) })),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['gf'] });
      navigate(`/oa/gov/${r.docId}`);
    },
    onError: (e) => toast({ tone: 'error', title: '没有提报', body: errorMessage(e) }),
  });
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-3xl"
      title="SKU 批量提报"
      description="同一供应商一批一张单，提交时逐个建码；协议价不含税。比同物料最低有效价高 10% 以上、核心品类的会单独列给董事长逐个确认"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!ok} onClick={() => m.mutate()}>
            提报 {lines.length} 个
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1.2fr_1fr_0.8fr_0.6fr_0.8fr_auto]">
            <Select value={l.materialId} onChange={(e) => set(i, { materialId: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">集团物料</option>
              {(mats.data ?? [])
                .filter((x) => x.active)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} {x.name}
                  </option>
                ))}
            </Select>
            <Input placeholder="SKU 名称" value={l.name} onChange={(e) => set(i, { name: e.target.value })} />
            <Input placeholder="规格" value={l.spec} onChange={(e) => set(i, { spec: e.target.value })} />
            <Input placeholder="单位" value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} />
            <Input placeholder="协议价（元）" inputMode="decimal" value={l.price} onChange={(e) => set(i, { price: e.target.value })} />
            <Button size="sm" variant="ghost" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              去掉
            </Button>
          </div>
        ))}
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setLines([...lines, { materialId: '', name: '', spec: '', unit: '', price: '' }])}>
          再加一个
        </Button>
      </div>
    </Dialog>
  );
}

function PriceDialog({ sku, onClose }: { sku: GfSkuView; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const cents = yuanToCents(price);
  const m = useMutation({
    mutationFn: () => api.post<{ docId: number }>(`/api/gf/skus/${sku.id}/price`, { clientKey, priceCents: cents, reason }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['gf'] });
      navigate(`/oa/gov/${r.docId}`);
    },
    onError: (e) => toast({ tone: 'error', title: '没有发起', body: errorMessage(e) }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`改协议价：${sku.skuCode}`}
      description="走 供应链负责人 → 董事长；通过后是新版本，历史单据保留原版本"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={cents === null || reason.trim().length < 2} onClick={() => m.mutate()}>
            提交
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[14px] text-ink-2">
          现行 <Money cents={sku.priceCents} className="text-[14px]" />
          （第 {sku.priceVersion} 版）
        </p>
        <Field label="新协议价（元，不含税）">
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="原因">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** 事项详情里：SKU 提报的差异摘要；董事长（终审）审时异常的要逐个给结论 */
export function SkuBatchReviewPanel({ doc, onDecisions }: { doc: GfDocDetail; onDecisions: (d: { skuId: number; decision: 'approve' | 'reject' }[] | null) => void }) {
  const q = useQuery({ queryKey: ['gf', 'sku-review', doc.id, doc.version], queryFn: () => api.get<SkuBatchReview>(`/api/gf/sku-batches/${doc.id}/review`) });
  const [picked, setPicked] = useState<Record<number, 'approve' | 'reject'>>({});
  if (!q.data) return null;
  const r = q.data;
  const pick = (skuId: number, d: 'approve' | 'reject') => {
    const next = { ...picked, [skuId]: d };
    setPicked(next);
    onDecisions(r.abnormal.every((a) => next[a.skuId]) ? r.abnormal.map((a) => ({ skuId: a.skuId, decision: next[a.skuId]! })) : null);
  };
  const final = doc.currentLevel === doc.nodes.length && doc.mySeats.length > 0;
  return (
    <Card className="space-y-2 p-4" data-testid="gf-sku-review">
      <h2 className="text-[15px] font-bold text-ink">
        {GF_DOC_TYPE_LABELS.sku_batch}差异摘要：{r.supplierName} 共 {r.count} 个，合计 <Money cents={r.totalCents} className="text-[15px]" />
      </h2>
      <p className="text-[13px] text-ink-2">
        正常 {r.normal.length} 个：{r.normal.map((n) => `${n.name} ¥${(n.priceCents / 100).toFixed(2)}`).join('、') || '—'}
      </p>
      {r.abnormal.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[13px] font-semibold text-clay">异常 {r.abnormal.length} 个（单独列出，终审要逐个给结论，不能一键全过）</p>
          {r.abnormal.map((a) => (
            <div key={a.skuId} className="flex flex-wrap items-center gap-2 rounded-md bg-paper-2 px-3 py-2 text-[13px]" data-testid={`gf-sku-abnormal-${a.skuId}`}>
              <span className="num text-ink-3">{a.skuCode}</span>
              <span className="font-semibold text-ink">{a.name}</span>
              <Money cents={a.priceCents} className="text-[13px]" />
              {a.refCents !== null && <span className="text-ink-3">同物料最低 ¥{(a.refCents / 100).toFixed(2)}</span>}
              <span className="text-clay">{a.reasons.map((x) => SKU_ABNORMAL_LABELS[x]).join('、')}</span>
              {final ? (
                <span className="ml-auto flex gap-1">
                  {(['approve', 'reject'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => pick(a.skuId, d)}
                      data-testid={`gf-sku-${d}-${a.skuId}`}
                      className={cn('tap relative h-8 rounded-full border px-3 font-semibold', picked[a.skuId] === d ? 'border-pine bg-pine text-paper' : 'border-line text-ink-2')}
                    >
                      {d === 'approve' ? '同意' : '不同意'}
                    </button>
                  ))}
                </span>
              ) : (
                r.decisions[a.skuId] && <span className="ml-auto">{r.decisions[a.skuId] === 'approve' ? '已同意' : '不同意'}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
