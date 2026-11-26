// 业财法 P04（docs/APPROVAL_V4.md 第 8 节）：七类合同。
//   /oa/gov?box=contracts   发起合同：按经济实质判定类型（混合合同提示拆分）、不含税 / 全合同期口径、选库内供应商与有效 SKU（单价带协议价）
// 事项详情里（ContractPanel）：合同号、版本、「其他」类财法确认归属、变更（只减金额保留原审批；核心变更重新路由）。

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { GF_FLAG_LABELS, GF_FLAGS, type GfDocDetail, type GfFlag, type GfMeta } from '@shared/govflow';
import {
  CONTRACT_CHANGE_FIELDS,
  CONTRACT_CHANGE_LABELS,
  CONTRACT_TYPES,
  CONTRACT_TYPE_HINTS,
  CONTRACT_TYPE_LABELS,
  PERIOD_BASED,
  type Classification,
  type ContractChangeField,
  type ContractSubstance,
  type ContractType,
  type ContractView,
} from '@shared/govflow-contract';
import type { GfSkuView } from '@shared/govflow-supply';
import { api, errorMessage } from '../../lib/api';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '../../components/ui';
import { yuanToCents } from './money';

const SUBSTANCE_LABELS: Record<keyof ContractSubstance, string> = {
  ownership: '取得物资所有权',
  laborResult: '取得劳务成果',
  construction: '施工与工程验收',
  periodUse: '一段期间的使用权',
  jointOperation: '联营、共担收益风险',
  equipmentInseparable: '施工附带的设备不可分',
  generalInstallOnly: '设备采购只附带一般安装',
  frameworkOrdersPriced: '框架无价但订单有价',
  hasAmount: '有金额',
};
const emptySubstance = (): ContractSubstance => ({
  ownership: false,
  laborResult: false,
  construction: false,
  periodUse: false,
  jointOperation: false,
  equipmentInseparable: false,
  generalInstallOnly: false,
  frameworkOrdersPriced: false,
  hasAmount: true,
});

const chip = (on: boolean) => cn('tap relative h-8 rounded-full border px-3 text-[13px] font-semibold', on ? 'border-pine bg-pine text-paper' : 'border-line text-ink-2');

export function ContractsPanel({ meta }: { meta: GfMeta }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3" data-testid="gf-contracts">
      <Card className="space-y-2 p-4 text-[13px] text-ink-2">
        <p>按经济实质分七类；审批按不含税金额（框架 / 按量 / 租赁 / 经营合作按全合同期）。</p>
        <p>终审：不到 1 万财总、1–5 万 CFO、5–30 万 CEO、30 万及以上董事长；重大风险 / 预付款 / 超预算至少 CFO；工程任何金额至少 CEO，30 万及以上 CEO → 董事长。</p>
        <Button size="sm" onClick={() => setOpen(true)} data-testid="gf-contract-new">
          发起合同
        </Button>
      </Card>
      {open && <ContractDialog meta={meta} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ContractDialog({ meta, onClose }: { meta: GfMeta; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const [type, setType] = useState<ContractType>('purchase');
  const [sub, setSub] = useState(emptySubstance);
  const [cls, setCls] = useState<Classification | null>(null);
  const [f, setF] = useState({
    title: '',
    counterparty: '',
    departmentId: '' as number | '',
    performerId: '' as number | '',
    total: '',
    perPeriod: '',
    periods: '',
    taxIncl: '',
    note: '',
    cannotSplit: '',
  });
  const [flags, setFlags] = useState<GfFlag[]>([]);
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [lines, setLines] = useState<{ skuId: number; qty: string }[]>([]);
  const suppliers = useQuery({ queryKey: ['gf', 'selector'], queryFn: () => api.get<{ id: number; name: string; changePending: boolean }[]>('/api/gf/selector/suppliers') });
  const skus = useQuery({
    queryKey: ['gf', 'selector', supplierId],
    queryFn: () => api.get<{ changePending: boolean; skus: GfSkuView[] }>(`/api/gf/selector/suppliers/${supplierId}/skus`),
    enabled: !!supplierId,
  });
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .post<Classification>('/api/gf/contracts/classify', sub)
        .then(setCls)
        .catch(() => setCls(null));
    }, 300);
    return () => clearTimeout(t);
  }, [sub]);
  const skuOf = (id: number) => skus.data?.skus.find((k) => k.id === id);
  const lineTotal = lines.reduce((a, l) => a + (skuOf(l.skuId)?.priceCents ?? 0) * (Number(l.qty) || 0), 0);
  const periodBased = PERIOD_BASED.includes(type);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ docId: number }>('/api/gf/contracts', {
        clientKey,
        type,
        title: f.title,
        counterparty: f.counterparty,
        departmentId: f.departmentId,
        performerId: f.performerId,
        supplierId: supplierId || null,
        substance: sub,
        cannotSplitReason: f.cannotSplit,
        flags,
        totalExTaxCents: lines.length ? lineTotal : f.total ? yuanToCents(f.total) : null,
        perPeriodExTaxCents: f.perPeriod ? yuanToCents(f.perPeriod) : null,
        periods: f.periods ? Number(f.periods) : null,
        taxInclusiveCents: f.taxIncl ? yuanToCents(f.taxIncl) : null,
        lines: lines.map((l) => ({ skuId: l.skuId, qty: Number(l.qty), priceCents: skuOf(l.skuId)?.priceCents })),
        note: f.note,
      }),
    onSuccess: (r) => navigate(`/oa/gov/${r.docId}`),
    onError: (e) => toast({ tone: 'error', title: '没有提交', body: errorMessage(e) }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-3xl"
      title="发起合同"
      description="部门负责人 → 内部履约执行人 → 财务、法务并行分审 → 金额 / 风险 / 工程终审；库内供应商 + 有效 SKU 免重复准入"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!f.title || !f.counterparty || !f.departmentId || !f.performerId} onClick={() => m.mutate()} data-testid="gf-contract-submit">
            提交审批
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="经济实质（勾选实际情况）">
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(SUBSTANCE_LABELS) as (keyof ContractSubstance)[]).map((k) => (
              <button key={k} type="button" className={chip(sub[k])} onClick={() => setSub({ ...sub, [k]: !sub[k] })}>
                {SUBSTANCE_LABELS[k]}
              </button>
            ))}
          </div>
        </Field>
        {cls && (
          <p className="rounded-md bg-paper-2 px-3 py-2 text-[13px] text-ink-2" data-testid="gf-contract-classify">
            建议归「{CONTRACT_TYPE_LABELS[cls.type]}」：{cls.reason}
            {cls.splitAdvice && <span className="block font-semibold text-clay">{cls.splitAdvice}</span>}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="合同类型" hint={CONTRACT_TYPE_HINTS[type]}>
            <Select value={type} onChange={(e) => setType(e.target.value as ContractType)}>
              {CONTRACT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CONTRACT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          {cls?.splitAdvice && (
            <Field label="不能拆的原因">
              <Input value={f.cannotSplit} onChange={(e) => setF({ ...f, cannotSplit: e.target.value })} />
            </Field>
          )}
          <Field label="合同名称">
            <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </Field>
          <Field label="相对方">
            <Input value={f.counterparty} onChange={(e) => setF({ ...f, counterparty: e.target.value })} />
          </Field>
          <Field label="费用承担部门">
            <Select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">请选择</option>
              {meta.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="内部履约执行人">
            <Select value={f.performerId} onChange={(e) => setF({ ...f, performerId: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">请选择</option>
              {meta.staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="库内供应商（选了才能免重复准入）">
            <Select
              value={supplierId}
              onChange={(e) => {
                setSupplierId(e.target.value ? Number(e.target.value) : '');
                setLines([]);
              }}
            >
              <option value="">不选（库外相对方，要先入库才能签署）</option>
              {(suppliers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.changePending ? '（变更审核中，不按库内简化）' : ''}
                </option>
              ))}
            </Select>
          </Field>
          {!lines.length &&
            (periodBased ? (
              <>
                <Field label="每期不含税（元）">
                  <Input inputMode="decimal" value={f.perPeriod} onChange={(e) => setF({ ...f, perPeriod: e.target.value })} />
                </Field>
                <Field label="期数（月）">
                  <Input inputMode="numeric" value={f.periods} onChange={(e) => setF({ ...f, periods: e.target.value })} />
                </Field>
              </>
            ) : (
              <Field label="不含税总价（元）">
                <Input inputMode="decimal" value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} />
              </Field>
            ))}
          <Field label="含税金额（元，付款按含税）">
            <Input inputMode="decimal" value={f.taxIncl} onChange={(e) => setF({ ...f, taxIncl: e.target.value })} />
          </Field>
        </div>
        {supplierId && (
          <Field label="SKU 明细（单价按现行协议价）">
            <div className="space-y-1.5">
              {lines.map((l, i) => {
                const k = skuOf(l.skuId);
                return (
                  <div key={i} className="flex items-center gap-2 text-[13px]">
                    <span className="min-w-0 flex-1 text-ink">
                      {k?.skuCode} {k?.name}
                    </span>
                    {k && <Money cents={k.priceCents} className="text-[13px]" />}
                    <Input className="w-24" inputMode="numeric" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                    <Button size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                      去掉
                    </Button>
                  </div>
                );
              })}
              <Select value="" onChange={(e) => e.target.value && setLines([...lines, { skuId: Number(e.target.value), qty: '1' }])}>
                <option value="">加一个有效 SKU</option>
                {(skus.data?.skus ?? []).map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.skuCode} {k.name} ¥{(k.priceCents / 100).toFixed(2)}
                  </option>
                ))}
              </Select>
              {lines.length > 0 && (
                <p className="text-[13px] text-ink-2">
                  明细合计（不含税）
                  <Money cents={lineTotal} className="text-[13px]" />
                </p>
              )}
            </div>
          </Field>
        )}
        <Field label="风险与情形">
          <div className="flex flex-wrap gap-1.5">
            {GF_FLAGS.map((x) => (
              <button key={x} type="button" className={chip(flags.includes(x))} onClick={() => setFlags(flags.includes(x) ? flags.filter((y) => y !== x) : [...flags, x])}>
                {GF_FLAG_LABELS[x]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="说明">
          <Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

/** 事项详情里：合同要点、版本、「其他」类确认归属、变更 */
export function ContractPanel({ doc, meta, onDone }: { doc: GfDocDetail; meta: GfMeta | undefined; onDone: (newId?: number) => void }) {
  const toast = useToast();
  const q = useQuery({
    queryKey: ['gf', 'contract', doc.id, doc.version],
    queryFn: () =>
      api.get<{ contract: ContractView; versions: { version: number; kind: string; approvalCents: number; reason: string; newDocId: number | null; createdAt: string }[] }>(
        `/api/gf/contracts/${doc.id}`,
      ),
  });
  const [confirm, setConfirm] = useState<ContractType | ''>('');
  const [changing, setChanging] = useState(false);
  const confirmM = useMutation({
    mutationFn: () => api.post(`/api/gf/contracts/${doc.id}/confirm-type`, { type: confirm }),
    onSuccess: () => onDone(),
    onError: (e) => toast({ tone: 'error', title: '没有确认', body: errorMessage(e) }),
  });
  if (!q.data) return null;
  const c = q.data.contract;
  const canConfirm = c.type === 'other' && !c.confirmedType && !!meta?.myRoles.some((r) => r === 'legal' || r === 'finance_reviewer');
  return (
    <Card className="space-y-2 p-4" data-testid="gf-contract-panel">
      <p className="flex flex-wrap items-center gap-2 text-[14px]">
        <span className="num font-bold text-ink">{c.contractNo}</span>
        <Badge tone="lake">{CONTRACT_TYPE_LABELS[c.type]}</Badge>
        {c.type === 'other' && <Badge tone={c.confirmedType ? 'moss' : 'clay'}>{c.confirmedType ? `财法确认归「${CONTRACT_TYPE_LABELS[c.confirmedType]}」` : '待财法确认归属'}</Badge>}
        {c.inLibrary && <Badge tone="moss">库内供应商 + 有效 SKU</Badge>}
        {c.supersededBy && <Badge tone="ink">已变更作废</Badge>}
      </p>
      <p className="text-[13px] text-ink-2">
        相对方 {c.counterparty} · 审批口径（不含税）
        <Money cents={c.approvalCents} className="text-[13px]" />
        {c.taxInclusiveCents !== null && (
          <>
            {' '}
            · 含税 <Money cents={c.taxInclusiveCents} className="text-[13px]" />
          </>
        )}
        {c.signedAt && ` · 签署 ${formatDateTime(c.signedAt)}`}
        {c.sealedAt && ` · 用印 ${formatDateTime(c.sealedAt)}`}
        {c.archiveDueOn && ` · ${c.archiveDueOn} 前归档`}
      </p>
      <p className="text-[13px] text-ink-3">
        版本：
        {q.data.versions.map((v) => `第 ${v.version} 版（${v.kind === 'initial' ? '初版' : v.kind === 'decrease' ? '减金额，保留原审批' : '核心变更，重新路由'}）`).join('；')}
      </p>
      {canConfirm && (
        <div className="flex gap-2">
          <Select value={confirm} onChange={(e) => setConfirm(e.target.value as ContractType | '')}>
            <option value="">确认归属</option>
            {CONTRACT_TYPES.filter((t) => t !== 'other').map((t) => (
              <option key={t} value={t}>
                {CONTRACT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <Button size="sm" disabled={!confirm} loading={confirmM.isPending} onClick={() => confirmM.mutate()}>
            确认
          </Button>
        </div>
      )}
      {doc.status !== 'reviewing' && doc.status !== 'withdrawn' && doc.status !== 'archived' && !c.supersededBy && (
        <Button size="sm" variant="secondary" onClick={() => setChanging(true)}>
          合同变更
        </Button>
      )}
      {changing && <ChangeDialog doc={doc} onClose={() => setChanging(false)} onDone={onDone} />}
    </Card>
  );
}

function ChangeDialog({ doc, onClose, onDone }: { doc: GfDocDetail; onClose: () => void; onDone: (newId?: number) => void }) {
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const [fields, setFields] = useState<ContractChangeField[]>(['amount']);
  const [total, setTotal] = useState(doc.amountCents ? (doc.amountCents / 100).toFixed(2) : '');
  const [counterparty, setCounterparty] = useState('');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post<{ docId: number; kept: boolean }>(`/api/gf/contracts/${doc.id}/change`, {
        clientKey,
        fields,
        totalExTaxCents: yuanToCents(total),
        reason,
        patch: counterparty ? { counterparty } : {},
      }),
    onSuccess: (r) => {
      toast({ tone: 'success', title: r.kept ? '只减金额：保留原审批，已记变更' : '核心变更：原审批作废，已按新内容重新提交审批' });
      onClose();
      onDone(r.kept ? undefined : r.docId);
    },
    onError: (e) => toast({ tone: 'error', title: '没有变更', body: errorMessage(e) }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="合同变更"
      description="只减金额、其他不变的保留原审批；其他核心变更原审批作废、按新内容重新路由"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!fields.length || reason.trim().length < 2 || yuanToCents(total) === null} onClick={() => m.mutate()}>
            提交变更
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {CONTRACT_CHANGE_FIELDS.map((x) => (
            <button key={x} type="button" className={chip(fields.includes(x))} onClick={() => setFields(fields.includes(x) ? fields.filter((y) => y !== x) : [...fields, x])}>
              {CONTRACT_CHANGE_LABELS[x]}
            </button>
          ))}
        </div>
        <Field label="变更后不含税总价（元）">
          <Input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
        </Field>
        {fields.includes('party') && (
          <Field label="新的相对方">
            <Input value={counterparty} onChange={(e) => setCounterparty(e.target.value)} />
          </Field>
        )}
        <Field label="原因">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
