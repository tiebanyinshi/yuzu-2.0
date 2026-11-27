// 采购商城 · 主数据两页（批次 D：FR-03 供应商档案页 + FR-04 集团物料主档页 + UX-07 桌面表格/移动端卡片化）。
// 复用 ERP 同一套 suppliers / supplier_licenses / materials / mall_skus 数据源，不另建审批体系、不绕过物料单位变更重审规则。

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Package, Search, Store as StoreIcon } from 'lucide-react';
import { formatYuan } from '@shared/money';
import { formatQty } from '@shared/quantity';
import { formatTaxRate, SHOP_SKU_STATUS_LABELS, type ShopCatalog, type ShopMaterialRow, type ShopSupplierDetail, type ShopSupplierRow } from '@shared/shop';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { MaterialImagesEditor, ProductImage } from './ProductImage';
import { ShopImageImportButton } from './ShopImageImport';

const BASE = '/erp/shop';

const LICENSE_KIND_LABELS: Record<string, string> = {
  business: '营业执照',
  food: '食品经营许可',
  health: '卫生许可',
  other: '其他资质',
};

function supplierStatusBadge(s: Pick<ShopSupplierRow, 'active' | 'admission'>): { text: string; tone: 'pine' | 'ember' | 'clay' | 'neutral' } {
  if (!s.active) return { text: '已停用', tone: 'neutral' };
  if (s.admission === 'approved') return { text: '已准入', tone: 'pine' };
  if (s.admission === 'suspended') return { text: '准入暂停', tone: 'clay' };
  return { text: '待准入', tone: 'ember' };
}

/** 主数据写操作统一走操作编号与「结果待确认」协议：先存本机读回核对再发；断网/超时/5xx 留在页面顶部查回、原样重提或作废 */
function useShopMasterWrite() {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const recorded = useErpRecorded(['shop_master']).filter((op) => op.staffId === session.staff.id);
  const blocked = recorded.length > 0;
  const run = async <T,>(
    opts: { method: 'PUT' | 'POST'; url: string; body: Record<string, unknown>; summary: string; okTitle: string },
    onSuccess?: (result: T) => void,
  ): Promise<'ok' | 'uncertain' | 'error'> => {
    if (blocked) {
      toast({ tone: 'error', title: '上一次主数据保存还没确认结果', body: '请先在页面顶部查回、按原内容重新提交或确认作废，再发起新的修改' });
      return 'error';
    }
    setBusy(true);
    try {
      const clientKey = uuid();
      const result = await sendErpOp<T>({
        key: clientKey,
        type: 'shop_master',
        method: opts.method,
        url: opts.url,
        body: { ...opts.body, clientKey },
        summary: `采购商城主数据 · ${opts.summary}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: opts.okTitle });
      void qc.invalidateQueries({ queryKey: ['shop'] });
      onSuccess?.(result);
      return 'ok';
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '结果待确认', body: '网络中断或服务器未返回结果，记录已留在本机。请在页面顶部查回结果、按原内容重新提交或确认作废。' });
        void qc.invalidateQueries({ queryKey: ['shop'] });
        return 'uncertain';
      }
      toast({ tone: 'error', title: errorMessage(e) });
      return 'error';
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, blocked };
}

// ───────────────────────── FR-03 供应商档案页 ─────────────────────────

export function ShopSuppliersPage({ catalog }: { catalog: ShopCatalog }) {
  const [kw, setKw] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'approved' | 'pending' | 'suspended' | 'inactive'>('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ['shop', 'suppliers'],
    queryFn: () => api.get<ShopSupplierRow[]>('/api/erp/shop/suppliers'),
  });

  const rows = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return (q.data ?? []).filter((s) => {
      if (statusFilter === 'approved' && (!s.active || s.admission !== 'approved')) return false;
      if (statusFilter === 'pending' && (!s.active || s.admission !== 'pending')) return false;
      if (statusFilter === 'suspended' && (!s.active || s.admission !== 'suspended')) return false;
      if (statusFilter === 'inactive' && s.active) return false;
      if (!k) return true;
      return `${s.name} ${s.code} ${s.categories.join(' ')} ${s.contact ?? ''}`.toLowerCase().includes(k);
    });
  }, [q.data, kw, statusFilter]);

  const columns: DataColumn<ShopSupplierRow>[] = [
    {
      key: 'name',
      header: '供应商',
      className: 'min-w-[180px]',
      cell: (s) => (
        <div>
          <p className="text-[13.5px] font-bold text-ink">{s.name}</p>
          <p className="text-[12.5px] text-ink-3">{s.code}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: '准入状态',
      cell: (s) => {
        const b = supplierStatusBadge(s);
        return <Badge tone={b.tone}>{b.text}</Badge>;
      },
    },
    {
      key: 'categories',
      header: '合作品类',
      className: 'max-w-[180px]',
      cell: (s) => <span className="text-[12.5px] text-ink-2">{s.categories.length ? s.categories.join('、') : '—'}</span>,
    },
    {
      key: 'skus',
      header: '在架 SKU',
      numeric: true,
      cell: (s) => (
        <span className="text-[13px]">
          {s.activeSkuCount} / {s.totalSkuCount}
        </span>
      ),
    },
    {
      key: 'lead',
      header: '默认交期',
      numeric: true,
      cell: (s) => <span className="text-[13px]">{s.avgLeadDays !== null ? `${s.avgLeadDays} 天` : '—'}</span>,
    },
    {
      key: 'priceAt',
      header: '最近改价',
      cell: (s) => <span className="text-[12.5px] whitespace-nowrap text-ink-3">{s.lastPriceChangeAt ? formatDateTime(s.lastPriceChangeAt) : '—'}</span>,
    },
    {
      key: 'contact',
      header: '联系人',
      cell: (s) => <span className="text-[12.5px] text-ink-2">{s.contact === null ? '联系采购获取' : s.contact || '—'}</span>,
    },
    {
      key: 'op',
      header: '操作',
      cell: (s) => (
        <Button size="sm" variant="secondary" onClick={() => setSelectedId(s.id)} data-testid={`shop-supplier-open-${s.id}`}>
          详情
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4" data-testid="shop-suppliers-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
            <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索供应商名称 / 编码 / 品类" className="h-9 pl-9" aria-label="搜索供应商" data-testid="shop-suppliers-search" />
          </div>
          <Select aria-label="准入状态筛选" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} fullWidth={false} className="h-9">
            <option value="all">全部状态</option>
            <option value="approved">已准入</option>
            <option value="pending">待准入</option>
            <option value="suspended">准入暂停</option>
            <option value="inactive">已停用</option>
          </Select>
        </div>
        <Link to="/inventory/master" className="inline-flex items-center gap-1 text-[13px] font-semibold text-pine hover:underline">
          前往 ERP 档案维护准入与证照
          <ExternalLink className="size-3.5" />
        </Link>
      </div>

      {q.error ? (
        <LoadFailed title="供应商档案没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <div className="hidden md:block">
            <DataTable
              onPage
              caption="采购商城供应商档案"
              columns={columns}
              rows={q.data ? rows : undefined}
              loading={q.isPending}
              rowKey={(s) => s.id}
              rowTestId={(s) => `shop-supplier-row-${s.id}`}
              onRowClick={(s) => setSelectedId(s.id)}
              empty="没有匹配的供应商"
              tableClassName="min-w-[860px]"
              testId="shop-suppliers-table"
            />
          </div>

          <div className="space-y-2.5 md:hidden" data-testid="shop-suppliers-mobile">
            {q.isPending ? (
              [0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)
            ) : rows.length === 0 ? (
              <Card className="p-4">
                <EmptyState art="search" title="没有匹配的供应商" />
              </Card>
            ) : (
              rows.map((s) => {
                const b = supplierStatusBadge(s);
                return (
                  <Card key={s.id} className="space-y-2 p-4" data-testid={`shop-supplier-card-${s.id}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[14.5px] font-bold text-ink">{s.name}</p>
                        <p className="text-[12.5px] text-ink-3">
                          {s.code} · 在架 {s.activeSkuCount} / {s.totalSkuCount} SKU
                        </p>
                      </div>
                      <Badge tone={b.tone}>{b.text}</Badge>
                    </div>
                    <p className="text-[12.5px] text-ink-2">
                      品类：{s.categories.length ? s.categories.join('、') : '—'} · 联系人：{s.contact === null ? '联系采购获取' : s.contact || '—'}
                    </p>
                    <div className="flex justify-end">
                      <Button size="sm" variant="secondary" onClick={() => setSelectedId(s.id)}>
                        查看档案
                      </Button>
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        </>
      )}

      {selectedId !== null && <SupplierDetailDialog supplierId={selectedId} canEdit={catalog.me.canEditMaster} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function SupplierDetailDialog({ supplierId, canEdit, onClose }: { supplierId: number; canEdit: boolean; onClose: () => void }) {
  const { run, busy, blocked } = useShopMasterWrite();
  const q = useQuery({
    queryKey: ['shop', 'supplier', supplierId],
    queryFn: () => api.get<ShopSupplierDetail>(`/api/erp/shop/suppliers/${supplierId}`),
  });
  const [editing, setEditing] = useState(false);
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');

  const d = q.data;
  const startEdit = () => {
    if (!d) return;
    setContact(d.contact ?? '');
    setPhone(d.phone ?? '');
    setNote(d.note);
    setEditing(true);
  };
  const save = async (patch: { contact?: string; phone?: string; note?: string; active?: boolean }, summary: string, okMsg: string) => {
    const status = await run({ method: 'PUT', url: `/api/erp/shop/suppliers/${supplierId}`, body: patch, summary, okTitle: okMsg });
    if (status === 'ok') setEditing(false);
    else if (status === 'uncertain') {
      setEditing(false);
      onClose();
    }
  };

  const badge = d ? supplierStatusBadge(d) : null;

  return (
    <Dialog open onClose={onClose} title={d ? `${d.name}（${d.code}）` : '供应商档案'} width="max-w-2xl">
      {q.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : q.error || !d ? (
        <LoadFailed title="供应商详情没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="space-y-4 text-[13px]" data-testid="shop-supplier-detail">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <StoreIcon className="size-4 text-pine" aria-hidden />
              {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
              {d.admissionByName && (
                <span className="text-[12.5px] text-ink-3">
                  {d.admissionByName} 审核 {d.admissionAt && formatDateTime(d.admissionAt)}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {canEdit && !editing && (
                <Button size="sm" variant="secondary" disabled={blocked} onClick={startEdit} data-testid="shop-supplier-edit-btn">
                  编辑联系与备注
                </Button>
              )}
              {canEdit && (
                <Button
                  size="sm"
                  variant={d.active ? 'ghost' : 'primary'}
                  loading={busy}
                  disabled={blocked}
                  onClick={() => void save({ active: !d.active }, `${d.active ? '停用' : '恢复'}供应商 ${d.name}`, d.active ? '已停用供应商' : '已恢复供应商')}
                  data-testid="shop-supplier-toggle-active"
                >
                  {d.active ? '停用' : '恢复启用'}
                </Button>
              )}
            </div>
          </div>

          {d.admission !== 'approved' && (
            <Notice tone="warning" title={`准入状态：${badge?.text ?? d.admission}`}>
              {d.admissionNote || '该供应商当前未通过准入，其关联 SKU 在商城中将统一拦截不可下单。'} 发起准入或登记证照请前往{' '}
              <Link to="/inventory/master" className="font-semibold text-pine hover:underline">
                ERP 供应商档案 →
              </Link>
            </Notice>
          )}

          {editing ? (
            <Card className="space-y-3 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="联系人" htmlFor="ss-contact">
                  <Input id="ss-contact" maxLength={40} value={contact} onChange={(e) => setContact(e.target.value)} />
                </Field>
                <Field label="联系电话" htmlFor="ss-phone">
                  <Input id="ss-phone" maxLength={32} value={phone} onChange={(e) => setPhone(e.target.value)} />
                </Field>
                <Field label="备注" htmlFor="ss-note" className="sm:col-span-2">
                  <Input id="ss-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  取消
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy}
                  disabled={blocked}
                  onClick={() => void save({ contact, phone, note }, `更新供应商 ${d.name}`, '供应商信息已保存')}
                  data-testid="shop-supplier-save"
                >
                  保存
                </Button>
              </div>
            </Card>
          ) : (
            <dl className="grid gap-x-4 gap-y-1.5 rounded-lg border border-line p-3 sm:grid-cols-2">
              <div className="flex justify-between gap-2">
                <dt className="text-ink-3">联系人</dt>
                <dd className="font-semibold text-ink">{d.contact === null ? '联系采购获取' : d.contact || '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-3">联系电话</dt>
                <dd className="text-ink">{d.phone === null ? '联系采购获取' : d.phone || '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-3">历史采购单数</dt>
                <dd className="font-semibold text-ink">{d.history.orderCount} 单</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-3">历史采购金额</dt>
                <dd className="font-semibold text-clay">{formatYuan(d.history.totalAmountCents)}</dd>
              </div>
              <div className="flex justify-between gap-2 sm:col-span-2">
                <dt className="text-ink-3">备注</dt>
                <dd className="text-ink-2">{d.note || '—'}</dd>
              </div>
            </dl>
          )}

          {/* 资质证照 */}
          <div className="space-y-2">
            <h4 className="text-[13.5px] font-bold text-ink">资质证照（{d.licenses.length}）</h4>
            {d.licenses.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">暂未登记证照，可在 ERP「库存 → 档案 → 供应商」补充营业执照与资质。</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {d.licenses.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">
                        <FileText className="mr-1 inline size-3.5 text-ink-3" />
                        {l.name || LICENSE_KIND_LABELS[l.kind] || l.kind} · {l.licenseNo}
                      </p>
                      <p className="text-[12.5px] text-ink-3">
                        有效期：{l.validUntil ?? '长期'} · {l.addedByName} 登记
                      </p>
                    </div>
                    {l.mediaUrl && (
                      <a href={l.mediaUrl} target="_blank" rel="noreferrer noopener" className="text-[12.5px] font-semibold text-pine hover:underline">
                        查看凭证 ↗
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 关联 SKU 与报价 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-[13.5px] font-bold text-ink">关联 SKU 与报价（{d.skus.length}）</h4>
              <Link to={`${BASE}/skus`} onClick={onClose} className="text-[12.5px] font-semibold text-pine hover:underline">
                前往 SKU 维护 →
              </Link>
            </div>
            {d.skus.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">该供应商尚未挂载商城 SKU。</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {d.skus.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">
                        {k.materialName}（{k.skuCode}）
                      </p>
                      <p className="text-[12.5px] text-ink-3">
                        含税 {formatYuan(k.grossCents)}/{k.unit}（税 {formatTaxRate(k.taxRateBp)}）· 起订 {formatQty(k.moqMilli)} {k.unit} · 交期 {k.leadDays} 天 · 有效至 {k.validUntil}
                      </p>
                    </div>
                    <Badge tone={k.status === 'approved' ? 'pine' : k.status === 'pending' ? 'ember' : 'neutral'}>{SHOP_SKU_STATUS_LABELS[k.status]}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ───────────────────────── FR-04 集团物料主档页 ─────────────────────────

export function ShopMaterialsPage({ catalog }: { catalog: ShopCatalog }) {
  const { run, busy, blocked } = useShopMasterWrite();
  const [kw, setKw] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [pickedIds, setPickedIds] = useState<number[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchCategory, setBatchCategory] = useState('');
  const [editingMat, setEditingMat] = useState<ShopMaterialRow | null>(null);

  const q = useQuery({
    queryKey: ['shop', 'materials'],
    queryFn: () => api.get<ShopMaterialRow[]>('/api/erp/shop/materials'),
  });

  const categories = useMemo(() => [...new Set((q.data ?? []).map((m) => m.category || '未分类'))].sort(), [q.data]);
  const rows = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return (q.data ?? []).filter((m) => {
      if (catFilter && (m.category || '未分类') !== catFilter) return false;
      if (activeFilter === 'active' && !m.active) return false;
      if (activeFilter === 'inactive' && m.active) return false;
      if (!k) return true;
      return `${m.code} ${m.name} ${m.specification} ${m.category} ${m.note}`.toLowerCase().includes(k);
    });
  }, [q.data, kw, catFilter, activeFilter]);

  const togglePick = (id: number) => setPickedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const toggleActive = async (m: ShopMaterialRow) => {
    await run({
      method: 'PUT',
      url: `/api/erp/shop/materials/${m.id}`,
      body: { active: !m.active },
      summary: `${m.active ? '停用' : '启用'}物料 ${m.name}`,
      okTitle: m.active ? `已停用「${m.name}」（商城不再展示，历史单据保留）` : `已恢复启用「${m.name}」`,
    });
  };

  const applyBatchCategory = async () => {
    if (!pickedIds.length) return;
    const cat = batchCategory.trim();
    const status = await run<{ id: number; updated: number }>(
      {
        method: 'POST',
        url: '/api/erp/shop/materials/batch-category',
        body: { materialIds: pickedIds, category: cat },
        summary: `批量修改 ${pickedIds.length} 个物料分类为「${cat || '未分类'}」`,
        okTitle: `已将 ${pickedIds.length} 个物料分类更新为「${cat || '未分类'}」`,
      },
      () => {
        setPickedIds([]);
        setBatchOpen(false);
        setBatchCategory('');
      },
    );
    if (status === 'uncertain') setBatchOpen(false);
  };

  const columns: DataColumn<ShopMaterialRow>[] = [
    ...(catalog.me.canEditMaster
      ? [
          {
            key: 'pick',
            header: '选',
            className: 'w-10',
            cell: (m: ShopMaterialRow) => (
              <input type="checkbox" checked={pickedIds.includes(m.id)} onChange={() => togglePick(m.id)} aria-label={`选择 ${m.name}`} data-testid={`shop-mat-check-${m.id}`} />
            ),
          },
        ]
      : []),
    {
      key: 'name',
      header: '物料',
      className: 'min-w-[200px]',
      cell: (m) => (
        <div className="flex items-center gap-2.5">
          <ProductImage imageIds={m.imageIds} name={m.name} category={m.category} className="size-10 shrink-0" rounded="rounded-lg" testId={`shop-mat-thumb-${m.id}`} />
          <div>
            <p className="text-[13.5px] font-bold text-ink">{m.name}</p>
            <p className="text-[12.5px] text-ink-3">
              {m.code}
              {m.specification && ` · ${m.specification}`}
            </p>
          </div>
        </div>
      ),
    },
    { key: 'category', header: '分类', cell: (m) => <Badge tone="neutral">{m.category || '未分类'}</Badge> },
    { key: 'unit', header: '采购单位', cell: (m) => <span className="text-[13px]">{m.unit}</span> },
    {
      key: 'skus',
      header: '报价家数 / SKU',
      numeric: true,
      cell: (m) => (
        <span className="text-[13px]">
          {m.supplierCount} 家 · {m.activeSkuCount}/{m.skuCount} SKU
        </span>
      ),
    },
    {
      key: 'lowest',
      header: '最低含税价',
      numeric: true,
      cell: (m) => <span className="text-[13px] font-semibold text-clay">{m.lowestGrossCents !== null ? `${formatYuan(m.lowestGrossCents)} / ${m.unit}` : '—'}</span>,
    },
    {
      key: 'status',
      header: '状态',
      cell: (m) => <Badge tone={m.active ? 'pine' : 'neutral'}>{m.active ? '在用' : '已停用'}</Badge>,
    },
    {
      key: 'op',
      header: '操作',
      cell: (m) => (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setEditingMat(m)} data-testid={`shop-mat-open-${m.id}`}>
            {catalog.me.canEditMaster ? '维护' : '详情'}
          </Button>
          {catalog.me.canEditMaster && (
            <Button size="sm" variant="ghost" loading={busy} disabled={blocked} onClick={() => void toggleActive(m)} data-testid={`shop-mat-toggle-${m.id}`}>
              {m.active ? '停用' : '启用'}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4" data-testid="shop-materials-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
            <Input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="搜索物料编码 / 名称 / 规格 / 分类"
              className="h-9 pl-9"
              aria-label="搜索物料主档"
              data-testid="shop-materials-search"
            />
          </div>
          <Select aria-label="分类筛选" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} fullWidth={false} className="h-9">
            <option value="">全部分类</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </Select>
          <Select aria-label="状态筛选" value={activeFilter} onChange={(e) => setActiveFilter(e.target.value as typeof activeFilter)} fullWidth={false} className="h-9">
            <option value="all">全部状态</option>
            <option value="active">在用</option>
            <option value="inactive">已停用</option>
          </Select>
          {catalog.me.canEditMaster && pickedIds.length > 0 && (
            <Button size="sm" variant="primary" disabled={blocked} onClick={() => setBatchOpen(true)} data-testid="shop-mat-batch-btn">
              批量改分类（已选 {pickedIds.length}）
            </Button>
          )}
        </div>
        {catalog.me.canEditMaster && <ShopImageImportButton disabled={blocked} />}
        <Link to="/inventory/master" className="inline-flex items-center gap-1 text-[13px] font-semibold text-pine hover:underline">
          单位与新建物料请前往 ERP 档案
          <ExternalLink className="size-3.5" />
        </Link>
      </div>

      <p className="text-[12.5px] text-ink-3">停用物料后商城目录立即不可见，但已提交的历史采购需求单仍正常保留与流转；修改采购单位须在 ERP 物料档案办理，并会自动触发关联 SKU 重新审核。</p>

      {q.error ? (
        <LoadFailed title="物料主档没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <div className="hidden md:block">
            <DataTable
              onPage
              caption="集团物料主档"
              columns={columns}
              rows={q.data ? rows : undefined}
              loading={q.isPending}
              rowKey={(m) => m.id}
              rowTestId={(m) => `shop-mat-row-${m.id}`}
              empty="没有匹配的物料"
              tableClassName="min-w-[880px]"
              testId="shop-materials-table"
            />
          </div>

          <div className="space-y-2.5 md:hidden" data-testid="shop-materials-mobile">
            {q.isPending ? (
              [0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)
            ) : rows.length === 0 ? (
              <Card className="p-4">
                <EmptyState art="search" title="没有匹配的物料" />
              </Card>
            ) : (
              rows.map((m) => (
                <Card key={m.id} className="space-y-2 p-4" data-testid={`shop-mat-card-${m.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2.5">
                      {catalog.me.canEditMaster && (
                        <label className="tap -m-2 inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            className="size-5 accent-pine"
                            checked={pickedIds.includes(m.id)}
                            onChange={() => togglePick(m.id)}
                            aria-label={`选择 ${m.name}`}
                            data-testid={`shop-mat-mobile-check-${m.id}`}
                          />
                        </label>
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-[14.5px] font-bold text-ink">{m.name}</p>
                        <p className="text-[12.5px] text-ink-3">
                          {m.code} · {m.category || '未分类'} · 单位 {m.unit}
                        </p>
                      </div>
                    </div>
                    <Badge tone={m.active ? 'pine' : 'neutral'}>{m.active ? '在用' : '已停用'}</Badge>
                  </div>
                  <p className="text-[12.5px] text-ink-2">
                    {m.supplierCount} 家供应商 · {m.activeSkuCount} 条在架 SKU{m.lowestGrossCents !== null ? ` · 最低 ${formatYuan(m.lowestGrossCents)}` : ''}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditingMat(m)}>
                      {catalog.me.canEditMaster ? '维护' : '详情'}
                    </Button>
                    {catalog.me.canEditMaster && (
                      <Button size="sm" variant="ghost" loading={busy} disabled={blocked} onClick={() => void toggleActive(m)}>
                        {m.active ? '停用' : '启用'}
                      </Button>
                    )}
                  </div>
                </Card>
              ))
            )}
          </div>
        </>
      )}

      {editingMat && <MaterialEditDialog material={editingMat} canEdit={catalog.me.canEditMaster} onClose={() => setEditingMat(null)} />}

      <Dialog
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        title={`批量修改 ${pickedIds.length} 个物料的分类`}
        width="max-w-sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setBatchOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} disabled={blocked} onClick={() => void applyBatchCategory()} data-testid="shop-mat-batch-save">
              确认修改
            </Button>
          </>
        }
      >
        <Field label="目标分类名称（留空则归入未分类）" htmlFor="shop-batch-cat">
          <Input id="shop-batch-cat" maxLength={16} value={batchCategory} onChange={(e) => setBatchCategory(e.target.value)} placeholder="例如：客用耗材" />
        </Field>
      </Dialog>
    </div>
  );
}

function MaterialEditDialog({ material, canEdit, onClose }: { material: ShopMaterialRow; canEdit: boolean; onClose: () => void }) {
  const { run, busy, blocked } = useShopMasterWrite();
  const [category, setCategory] = useState(material.category);
  const [note, setNote] = useState(material.note);
  const [active, setActive] = useState(material.active);

  const save = async () => {
    const status = await run({
      method: 'PUT',
      url: `/api/erp/shop/materials/${material.id}`,
      body: { category: category.trim(), note: note.trim(), active },
      summary: `更新物料 ${material.name}`,
      okTitle: '物料主档已保存',
    });
    if (status === 'ok' || status === 'uncertain') onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${material.name}（${material.code}）`}
      width="max-w-lg"
      footer={
        canEdit ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" loading={busy} disabled={blocked} onClick={() => void save()} data-testid="shop-mat-save">
              保存
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        )
      }
    >
      <div className="space-y-3 text-[13px]" data-testid="shop-mat-detail">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-paper-2/50 p-3">
          <div className="flex items-center gap-2">
            <Package className="size-4 text-pine" aria-hidden />
            <span>
              规格：{material.specification || '—'} · 采购单位 <strong>{material.unit}</strong>（库存单位 {material.inventoryUnit}）
            </span>
          </div>
          {material.active && material.activeSkuCount > 0 && (
            <Link to={`${BASE}/compare/${material.id}`} onClick={onClose} className="text-[12.5px] font-semibold text-pine hover:underline">
              查看比价表 →
            </Link>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="分类" htmlFor="sm-cat">
            <Input id="sm-cat" maxLength={16} disabled={!canEdit} value={category} onChange={(e) => setCategory(e.target.value)} />
          </Field>
          <Field label="在用状态" htmlFor="sm-active">
            <Select id="sm-active" disabled={!canEdit} value={active ? '1' : '0'} onChange={(e) => setActive(e.target.value === '1')}>
              <option value="1">在用（商城可见）</option>
              <option value="0">已停用（商城隐藏，历史单据保留）</option>
            </Select>
          </Field>
          <Field label="备注" htmlFor="sm-note" className="sm:col-span-2">
            <Input id="sm-note" maxLength={200} disabled={!canEdit} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <MaterialImagesEditor materialId={material.id} name={material.name} imageIds={material.imageIds} canEdit={canEdit} run={run} busy={busy} blocked={blocked} />
        <p className="text-[12.5px] text-ink-3">
          当前关联 {material.supplierCount} 家供应商、{material.activeSkuCount} 条在架 SKU（共 {material.skuCount} 条）。如需修改采购单位或换算，请前往 ERP 库存档案，改动后关联 SKU
          将按规则重新审核上架。
        </p>
      </div>
    </Dialog>
  );
}
