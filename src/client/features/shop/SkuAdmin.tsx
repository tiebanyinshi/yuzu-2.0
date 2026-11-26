// 采购商城 · SKU 维护（8.1.32，docs/MALL_V8132.md 第 3 节）：采购建草稿、提交；有「采购规则」权限的人审核上架（不能批自己提交的，店主除外）。
// 上架以后改价格、税率、起订量、运费、有效期、适用门店要提「改动」：提了这条 SKU 暂停采购，批了才生效、价格版本加一。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { formatYuan, parseYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import { formatTaxRate, SHOP_SKU_STATUS_LABELS, SHOP_TAX_RATES, type ShopCatalog, type ShopSku, type ShopSkuCore } from '@shared/shop';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Select, Skeleton } from '../../components/ui';

const key = ['shop', 'skus'] as const;

interface Form {
  materialId: string;
  supplierId: string;
  skuCode: string;
  price: string;
  taxRateBp: string;
  moq: string;
  leadDays: string;
  freight: string;
  validUntil: string;
  storeIds: number[];
  note: string;
}
const blank: Form = { materialId: '', supplierId: '', skuCode: '', price: '', taxRateBp: '1300', moq: '1', leadDays: '3', freight: '0', validUntil: '', storeIds: [], note: '' };
const fromSku = (s: ShopSku): Form => ({
  materialId: String(s.material.id),
  supplierId: String(s.supplier.id),
  skuCode: s.skuCode,
  price: (s.priceCents / 100).toFixed(2),
  taxRateBp: String(s.taxRateBp),
  moq: formatQty(s.moqMilli),
  leadDays: String(s.leadDays),
  freight: (s.freightCents / 100).toFixed(2),
  validUntil: s.validUntil,
  storeIds: s.stores.map((x) => x.id),
  note: s.note,
});
function coreOf(f: Form): ShopSkuCore | string {
  const priceCents = parseYuan(f.price);
  const freightCents = parseYuan(f.freight || '0');
  const moqMilli = parseQty(f.moq);
  if (priceCents === null || priceCents <= 0) return '未税单价要大于 0';
  if (freightCents === null || freightCents < 0) return '运费填得不对';
  if (!moqMilli) return '起订量要大于 0';
  if (!f.validUntil) return '请填价格有效期';
  return { priceCents, taxRateBp: Number(f.taxRateBp), moqMilli, freightCents, validUntil: f.validUntil, storeIds: f.storeIds };
}

export function SkuAdmin({ catalog }: { catalog: ShopCatalog }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ShopSku[]>('/api/erp/shop/skus') });
  const [editing, setEditing] = useState<ShopSku | 'new' | null>(null);
  const [changing, setChanging] = useState<ShopSku | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (url: string, body: unknown, ok: string) => {
    setBusy(true);
    try {
      await api.post(url, body);
      toast({ tone: 'success', title: ok });
    } catch (e) {
      // 结果不确定（超时、断网、服务器出错）：列表已刷新，看这条是不是已经变了；请求带着版本号，再点一次已经生效的会被拒、不会重复生效
      if (e instanceof UncertainError) toast({ tone: 'info', title: '结果待确认', body: '列表已刷新：先看这条 SKU 的状态有没有变，没变再点一次（不会重复生效）' });
      else toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['shop'] });
    }
  };
  if (q.isPending) return <Skeleton className="h-64" />;
  if (q.error) return <LoadFailed title="SKU 没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  return (
    <div className="space-y-3" data-testid="shop-skus">
      <div className="flex flex-wrap items-center gap-2">
        {catalog.me.canManageSku && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="shop-sku-new">
            新建 SKU
          </Button>
        )}
        <span className="text-[12.5px] text-ink-3">一个 SKU 只挂一个物料；同一物料可以挂几家供应商。上架要另一位有「采购规则」权限的同事审核。</span>
      </div>
      {q.data.length === 0 ? (
        <Card className="p-8 text-center text-[13.5px] text-ink-3">还没有 SKU：新建一条，审核上架以后部门就能在商城里选到。</Card>
      ) : (
        <Card className="divide-y divide-line">
          {q.data.map((s) => (
            <div key={s.id} className="space-y-2 p-4" data-testid={`shop-sku-${s.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-bold text-ink">{s.material.name}</span>
                <span className="text-[12.5px] text-ink-3">
                  {s.supplier.name} · {s.skuCode} · V{s.priceVersion}
                </span>
                <Badge tone={s.status === 'approved' ? 'pine' : s.status === 'pending' ? 'ember' : 'neutral'}>{SHOP_SKU_STATUS_LABELS[s.status]}</Badge>
                {s.corePending && <Badge tone="ember">改动审核中</Badge>}
                {s.supplier.admission !== 'approved' && <Badge tone="clay">供应商未准入</Badge>}
              </div>
              <p className="text-[12.5px] text-ink-2">
                未税 {formatYuan(s.priceCents)} · 税 {formatTaxRate(s.taxRateBp)} · 含税 {formatYuan(s.grossCents)} / {s.material.unit} · 起订 {formatQty(s.moqMilli)} {s.material.unit} · 交期{' '}
                {s.leadDays} 天 · 运费 {s.freightCents === 0 ? '包邮' : formatYuan(s.freightCents)} · 有效至 {s.validUntil} · 门店 {s.stores.length ? s.stores.map((x) => x.name).join('、') : '全部'}
              </p>
              {s.approvedByName && (
                <p className="text-[12.5px] text-ink-3">
                  {s.approvedByName} 审核上架 {s.approvedAt && formatDateTime(s.approvedAt)}
                </p>
              )}
              {s.pendingChange && (
                <Notice tone="warning" title={`待审改动（${s.pendingChange.requestedByName}）：${s.pendingChange.reason}`}>
                  改成：未税 {formatYuan(s.pendingChange.after.priceCents)}、税 {formatTaxRate(s.pendingChange.after.taxRateBp)}、起订 {formatQty(s.pendingChange.after.moqMilli)} {s.material.unit}
                  、运费 {s.pendingChange.after.freightCents === 0 ? '包邮' : formatYuan(s.pendingChange.after.freightCents)}、有效至 {s.pendingChange.after.validUntil}、适用门店{' '}
                  <b data-testid={`shop-sku-change-stores-${s.id}`}>
                    {s.pendingChange.after.storeIds.length ? s.pendingChange.after.storeIds.map((id) => catalog.stores.find((x) => x.id === id)?.name ?? `门店 ${id}`).join('、') : '全部门店'}
                  </b>
                  。审核期间这条 SKU 暂停采购。
                  <span className="mt-2 flex flex-wrap gap-2">
                    {catalog.me.canApproveSku && (
                      <>
                        <Button size="sm" variant="primary" loading={busy} onClick={() => void act(`/api/erp/shop/changes/${s.pendingChange!.id}/approve`, {}, '改动已生效，价格版本加一')}>
                          批准
                        </Button>
                        <Button size="sm" loading={busy} onClick={() => void act(`/api/erp/shop/changes/${s.pendingChange!.id}/reject`, {}, '已驳回，SKU 恢复采购')}>
                          驳回
                        </Button>
                      </>
                    )}
                    <Button size="sm" variant="ghost" loading={busy} onClick={() => void act(`/api/erp/shop/changes/${s.pendingChange!.id}/withdraw`, {}, '已撤回')}>
                      撤回
                    </Button>
                  </span>
                </Notice>
              )}
              <div className="flex flex-wrap gap-2">
                {catalog.me.canManageSku && s.status !== 'disabled' && (
                  <Button size="sm" onClick={() => setEditing(s)}>
                    {s.status === 'draft' ? '修改' : '改交期、备注'}
                  </Button>
                )}
                {catalog.me.canManageSku && s.status === 'draft' && (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy}
                    onClick={() => void act(`/api/erp/shop/skus/${s.id}/submit`, { version: s.version }, '已提交审核')}
                    data-testid={`shop-sku-submit-${s.id}`}
                  >
                    提交审核
                  </Button>
                )}
                {catalog.me.canApproveSku && s.status === 'pending' && (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busy}
                      onClick={() => void act(`/api/erp/shop/skus/${s.id}/approve`, { version: s.version }, '已上架')}
                      data-testid={`shop-sku-approve-${s.id}`}
                    >
                      审核上架
                    </Button>
                    <Button size="sm" loading={busy} onClick={() => void act(`/api/erp/shop/skus/${s.id}/return`, { note: '请补充资料', version: s.version }, '已退回草稿')}>
                      退回
                    </Button>
                  </>
                )}
                {catalog.me.canManageSku && s.status === 'approved' && !s.corePending && (
                  <Button size="sm" onClick={() => setChanging(s)}>
                    改价 / 改核心信息
                  </Button>
                )}
                {catalog.me.canManageSku && s.status === 'approved' && (
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => void act(`/api/erp/shop/skus/${s.id}/disable`, { version: s.version }, '已停用')}>
                    停用
                  </Button>
                )}
                {catalog.me.canManageSku && s.status === 'disabled' && (
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => void act(`/api/erp/shop/skus/${s.id}/enable`, { version: s.version }, '已提交重新上架，等审核')}>
                    重新上架
                  </Button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
      {editing && <SkuDialog catalog={catalog} sku={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {changing && <ChangeDialog catalog={catalog} sku={changing} onClose={() => setChanging(null)} />}
    </div>
  );
}

function StorePicker({ catalog, value, onChange }: { catalog: ShopCatalog; value: number[]; onChange: (v: number[]) => void }) {
  return (
    <Field label="适用门店（业态）" hint="都不勾 = 全部门店">
      <div className="flex flex-wrap gap-3">
        {catalog.stores.map((s) => (
          <label key={s.id} className="inline-flex items-center gap-1.5 text-[13px]">
            <input type="checkbox" checked={value.includes(s.id)} onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((x) => x !== s.id))} />
            {s.name}
          </label>
        ))}
      </div>
    </Field>
  );
}

function CoreFields({ f, set }: { f: Form; set: (f: Form) => void }) {
  return (
    <>
      <Field label="未税单价（元）" htmlFor="sku-price">
        <Input id="sku-price" inputMode="decimal" value={f.price} onChange={(e) => set({ ...f, price: e.target.value })} />
      </Field>
      <Field label="税率" htmlFor="sku-tax">
        <Select id="sku-tax" value={f.taxRateBp} onChange={(e) => set({ ...f, taxRateBp: e.target.value })}>
          {SHOP_TAX_RATES.map((t) => (
            <option key={t} value={t}>
              {formatTaxRate(t)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="起订量" htmlFor="sku-moq">
        <Input id="sku-moq" inputMode="decimal" value={f.moq} onChange={(e) => set({ ...f, moq: e.target.value })} />
      </Field>
      <Field label="运费（元，每次采购一笔）" htmlFor="sku-freight">
        <Input id="sku-freight" inputMode="decimal" value={f.freight} onChange={(e) => set({ ...f, freight: e.target.value })} />
      </Field>
      <Field label="价格有效至" htmlFor="sku-valid">
        <Input id="sku-valid" type="date" value={f.validUntil} onChange={(e) => set({ ...f, validUntil: e.target.value })} />
      </Field>
    </>
  );
}

function SkuDialog({ catalog, sku, onClose }: { catalog: ShopCatalog; sku: ShopSku | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Form>(sku ? fromSku(sku) : blank);
  const [busy, setBusy] = useState(false);
  // 选物料、供应商用商城自己的接口（只有「采购管理」的人也能取，Codex 审查）；取不回来显示原因与重试，不当成空的
  const master = useQuery({
    queryKey: ['shop', 'master'],
    queryFn: () =>
      api.get<{ materials: { id: number; code: string; name: string; unit: string }[]; suppliers: { id: number; code: string; name: string; admission: string }[] }>('/api/erp/shop/master'),
  });
  const draft = !sku || sku.status === 'draft';
  const save = async () => {
    const core = coreOf(f);
    if (typeof core === 'string') return toast({ tone: 'error', title: core });
    const body = { ...core, materialId: Number(f.materialId), supplierId: Number(f.supplierId), skuCode: f.skuCode.trim(), leadDays: Number(f.leadDays) || 0, note: f.note.trim() };
    setBusy(true);
    try {
      if (sku) await api.put(`/api/erp/shop/skus/${sku.id}`, { ...body, version: sku.version });
      else await api.post('/api/erp/shop/skus', body);
      toast({ tone: 'success', title: sku ? '已保存' : '已建草稿：提交审核后才上架' });
      void qc.invalidateQueries({ queryKey: ['shop'] });
      onClose();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={sku ? `修改 ${sku.skuCode}` : '新建 SKU'}
      width="max-w-2xl"
      footer={
        <Button variant="primary" loading={busy} disabled={!master.data || !f.materialId || !f.supplierId || !f.skuCode.trim()} onClick={() => void save()} data-testid="shop-sku-save">
          保存
        </Button>
      }
    >
      {master.isPending && <Skeleton className="mb-3 h-10" />}
      {master.error && <LoadFailed title="物料、供应商没有取回来，暂时选不了" onRetry={() => void master.refetch()} retrying={master.isFetching} className="mb-3" />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="物料" htmlFor="sku-mat">
          <Select id="sku-mat" value={f.materialId} disabled={!draft} onChange={(e) => setF({ ...f, materialId: e.target.value })}>
            <option value="">请选择</option>
            {(master.data?.materials ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="供应商" htmlFor="sku-sup">
          <Select id="sku-sup" value={f.supplierId} disabled={!draft} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
            <option value="">请选择</option>
            {(master.data?.suppliers ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="SKU 编码" htmlFor="sku-code">
          <Input id="sku-code" maxLength={40} value={f.skuCode} disabled={!draft} onChange={(e) => setF({ ...f, skuCode: e.target.value })} />
        </Field>
        <Field label="交期（天）" htmlFor="sku-lead">
          <Input id="sku-lead" inputMode="numeric" value={f.leadDays} onChange={(e) => setF({ ...f, leadDays: e.target.value })} />
        </Field>
        {draft ? <CoreFields f={f} set={setF} /> : <p className="text-[12.5px] text-ink-3 sm:col-span-2">已提交的 SKU 改价格、税率、起订量、运费、有效期、适用门店要用「改价 / 改核心信息」。</p>}
        <Field label="备注" htmlFor="sku-note" className="sm:col-span-2">
          <Input id="sku-note" maxLength={200} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {draft && (
          <div className="sm:col-span-2">
            <StorePicker catalog={catalog} value={f.storeIds} onChange={(storeIds) => setF({ ...f, storeIds })} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ChangeDialog({ catalog, sku, onClose }: { catalog: ShopCatalog; sku: ShopSku; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Form>(fromSku(sku));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const core = coreOf(f);
    if (typeof core === 'string') return toast({ tone: 'error', title: core });
    setBusy(true);
    try {
      await api.post(`/api/erp/shop/skus/${sku.id}/changes`, { ...core, reason: reason.trim(), version: sku.version });
      toast({ tone: 'success', title: '已提交改动：审核期间这条 SKU 暂停采购' });
      void qc.invalidateQueries({ queryKey: ['shop'] });
      onClose();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`改动 ${sku.skuCode}`}
      width="max-w-2xl"
      footer={
        <Button variant="primary" loading={busy} disabled={reason.trim().length < 2} onClick={() => void save()}>
          提交审核
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <CoreFields f={f} set={setF} />
        <div className="sm:col-span-2">
          <StorePicker catalog={catalog} value={f.storeIds} onChange={(storeIds) => setF({ ...f, storeIds })} />
        </div>
        <Field label="原因" htmlFor="sku-reason" className="sm:col-span-2">
          <Input id="sku-reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：供应商 12 月起调价" />
        </Field>
      </div>
    </Dialog>
  );
}
