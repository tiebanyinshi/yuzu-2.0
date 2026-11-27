// 业财法 P06（docs/APPROVAL_V4.md 第 10 节）：报销、出差（部门月度差旅预算）、商务招待、用印证照。
//   /oa/gov?box=expense   四个入口 + 本部门（内控看全部）的差旅额度 + 证照台账（借出、超期）

import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { GfDocCard, GfMeta } from '@shared/govflow';
import { SEAL_KINDS, SEAL_KIND_LABELS, type LicenseView, type SealKind, type TravelBudgetView } from '@shared/govflow-expense';
import { api, errorMessage } from '../../lib/api';
import { uuid } from '../../lib/utils';
import { DataTable } from '../../components/DataTable';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '../../components/ui';
import { yuanToCents } from './money';

type Kind = 'expense' | 'travel' | 'entertain' | 'seal';

export function ExpensePanel({ meta }: { meta: GfMeta }) {
  const [open, setOpen] = useState<Kind | null>(null);
  const budgets = useQuery({ queryKey: ['gf', 'travel-budgets'], queryFn: () => api.get<TravelBudgetView[]>('/api/gf/travel-budgets') });
  const licenses = useQuery({ queryKey: ['gf', 'licenses'], queryFn: () => api.get<LicenseView[]>('/api/gf/licenses') });
  return (
    <div className="space-y-3" data-testid="gf-expense">
      <Card className="flex flex-wrap gap-2 p-4">
        <Button size="sm" onClick={() => setOpen('expense')} data-testid="gf-expense-new">
          报销
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen('travel')}>
          出差申请
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen('entertain')}>
          商务招待
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen('seal')}>
          用印证照
        </Button>
        {/* 报销统一成一套（8.2.17，WB11）：写明分工，并能跳到以前在 WCP「审批」里提的报销 */}
        <p className="w-full text-[12.5px] text-ink-3" data-testid="gf-expense-unified">
          报销只在这里发起、查看，审批按业财法的规则走，审批记录只有这一份。以前在 WCP「审批」里提的报销照旧在
          <Link to="/oa/approvals" className="mx-0.5 font-semibold text-pine underline">
            审批列表
          </Link>
          里查看。
        </p>
      </Card>
      <h2 className="text-[15px] font-bold text-ink">部门本月差旅额度</h2>
      <DataTable<TravelBudgetView>
        rows={budgets.data}
        loading={budgets.isPending}
        rowKey={(b) => b.departmentId}
        empty="还没设差旅批复额度"
        columns={[
          { key: 'dept', header: '部门', cell: (b) => b.departmentName },
          { key: 'budget', header: '批复', numeric: true, cell: (b) => <Money cents={b.budgetCents} /> },
          { key: 'used', header: '已用', numeric: true, cell: (b) => <Money cents={b.usedCents} /> },
          { key: 'frozen', header: '冻结', numeric: true, cell: (b) => <Money cents={b.frozenCents} /> },
          { key: 'left', header: '剩余', numeric: true, cell: (b) => <Money cents={b.remainingCents} /> },
        ]}
      />
      <h2 className="text-[15px] font-bold text-ink">证照</h2>
      <DataTable<LicenseView>
        rows={licenses.data}
        loading={licenses.isPending}
        rowKey={(l) => l.id}
        empty="章证管理员还没登记证照"
        columns={[
          { key: 'name', header: '证照', cell: (l) => l.name },
          { key: 'kind', header: '类型', cell: (l) => (l.kind === 'electronic' ? '电子（只发水印副本）' : '纸质（借还）') },
          {
            key: 'loan',
            header: '借出',
            cell: (l) => (l.onLoan ? <Badge tone={l.onLoan.overdue ? 'clay' : 'ember'}>{`${l.onLoan.borrowerName} · ${l.onLoan.dueOn} 前还${l.onLoan.overdue ? '（超期）' : ''}`}</Badge> : '在库'),
          },
        ]}
      />
      {open && <NewDialog kind={open} meta={meta} budgets={budgets.data ?? []} licenses={licenses.data ?? []} onClose={() => setOpen(null)} />}
    </div>
  );
}

const TITLES: Record<Kind, [string, string]> = {
  expense: ['报销', '部门负责人 → 财务 → 出纳，不因金额升级；无票先财总复核；同一张发票、已用备用金的不能重复报销'],
  travel: ['出差申请', '预算内 部门负责人 → 财务；超部门本月差旅预算的登记转下月，特殊事项财总＋CFO 特批'],
  entertain: ['商务招待', '超过 2 万加财总、超过 5 万加 CFO；无事前申请至少财总；金额、人数减少不重审'],
  seal: ['用印证照', '已批合同没改动不重审；非合同文件负责人 + 财法按内容审；空白文件财总＋经营主体负责人特批'],
};

function NewDialog({ kind, meta, budgets, licenses, onClose }: { kind: Kind; meta: GfMeta; budgets: TravelBudgetView[]; licenses: LicenseView[]; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [clientKey] = useState(uuid);
  const mine = useQuery({ queryKey: ['gf', 'docs', 'mine'], queryFn: () => api.get<GfDocCard[]>('/api/gf/docs?box=mine') });
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({
    departmentId: '' as number | '',
    title: '',
    amount: '',
    invoiceNo: '',
    travelDocId: '' as number | '',
    destination: '',
    startDate: today,
    endDate: today,
    priorApplied: true,
    overStandard: false,
    majorAbnormal: false,
    overBudgetMode: '' as '' | 'defer' | 'special',
    guests: '',
    people: '1',
    sealKind: 'document' as SealKind,
    contractDocId: '' as number | '',
    licenseId: '' as number | '',
    highRisk: false,
    purpose: '',
  });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const cents = yuanToCents(f.amount);
  const body = (): [string, Record<string, unknown>] => {
    const base = { clientKey, departmentId: f.departmentId, title: f.title };
    switch (kind) {
      case 'expense':
        return ['/api/gf/expenses', { ...base, amountCents: cents, invoiceNo: f.invoiceNo, travelDocId: f.travelDocId || null }];
      case 'travel':
        return [
          '/api/gf/travel',
          {
            ...base,
            amountCents: cents,
            destination: f.destination,
            startDate: f.startDate,
            endDate: f.endDate,
            priorApplied: f.priorApplied,
            overStandard: f.overStandard,
            majorAbnormal: f.majorAbnormal,
            overBudgetMode: f.overBudgetMode || null,
          },
        ];
      case 'entertain':
        return ['/api/gf/entertain', { ...base, amountCents: cents, guests: f.guests, people: Number(f.people), priorApplied: f.priorApplied }];
      case 'seal':
        return ['/api/gf/seals', { ...base, kind: f.sealKind, contractDocId: f.contractDocId || null, licenseId: f.licenseId || null, highRisk: f.highRisk, purpose: f.purpose }];
    }
  };
  const m = useMutation({
    mutationFn: () => {
      const [url, b] = body();
      return api.post<{ docId: number }>(url, b);
    },
    onSuccess: (r) => navigate(`/oa/gov/${r.docId}`),
    onError: (e) => toast({ tone: 'error', title: '没有提交', body: errorMessage(e) }),
  });
  const budget = budgets.find((b) => b.departmentId === f.departmentId);
  const check = (label: ReactNode, k: 'priorApplied' | 'overStandard' | 'majorAbnormal' | 'highRisk') => (
    <label className="flex items-center gap-2 text-[14px] text-ink">
      <input type="checkbox" checked={f[k]} onChange={(e) => set({ [k]: e.target.checked })} />
      {label}
    </label>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title={TITLES[kind][0]}
      description={TITLES[kind][1]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button loading={m.isPending} disabled={!f.departmentId || f.title.trim().length < 2 || (kind !== 'seal' && cents === null)} onClick={() => m.mutate()}>
            提交
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="部门">
          <Select value={f.departmentId} onChange={(e) => set({ departmentId: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">请选择</option>
            {meta.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="事由">
          <Input value={f.title} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        {kind !== 'seal' && (
          <Field label="金额（元）">
            <Input inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} />
          </Field>
        )}
        {kind === 'expense' && (
          <>
            <Field label="发票号（没有的留空，财总复核）">
              <Input value={f.invoiceNo} onChange={(e) => set({ invoiceNo: e.target.value })} />
            </Field>
            <Field label="关联出差申请">
              <Select value={f.travelDocId} onChange={(e) => set({ travelDocId: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">不是出差报销</option>
                {(mine.data ?? [])
                  .filter((d) => d.docType === 'travel' && d.status === 'to_execute')
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.bizNo} {d.title}
                    </option>
                  ))}
              </Select>
            </Field>
          </>
        )}
        {kind === 'travel' && (
          <>
            <Field label="目的地">
              <Input value={f.destination} onChange={(e) => set({ destination: e.target.value })} />
            </Field>
            <Field label="开始">
              <Input type="date" value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            </Field>
            <Field label="结束">
              <Input type="date" value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} />
            </Field>
            {budget && (
              <p className="text-[13px] text-ink-2 sm:col-span-2">
                部门本月差旅：批复 <Money cents={budget.budgetCents} className="text-[13px]" />
                、已用 <Money cents={budget.usedCents} className="text-[13px]" />
                、冻结 <Money cents={budget.frozenCents} className="text-[13px]" />
                、剩余 <Money cents={budget.remainingCents} className="text-[13px]" />
              </p>
            )}
            <Field label="超预算时">
              <Select value={f.overBudgetMode} onChange={(e) => set({ overBudgetMode: e.target.value as typeof f.overBudgetMode })}>
                <option value="">不超预算</option>
                <option value="defer">登记转下月</option>
                <option value="special">特殊事项，财总＋CFO 特批</option>
              </Select>
            </Field>
            {check('事前已申请', 'priorApplied')}
            {check('超标准', 'overStandard')}
            {check('重大异常', 'majorAbnormal')}
          </>
        )}
        {kind === 'entertain' && (
          <>
            <Field label="客人">
              <Input value={f.guests} onChange={(e) => set({ guests: e.target.value })} />
            </Field>
            <Field label="人数">
              <Input inputMode="numeric" value={f.people} onChange={(e) => set({ people: e.target.value.replace(/\D/g, '') })} />
            </Field>
            {check('事前已申请', 'priorApplied')}
          </>
        )}
        {kind === 'seal' && (
          <>
            <Field label="类型">
              <Select value={f.sealKind} onChange={(e) => set({ sealKind: e.target.value as SealKind })}>
                {SEAL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {SEAL_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            {f.sealKind === 'contract' && (
              <Field label="合同">
                <Select value={f.contractDocId} onChange={(e) => set({ contractDocId: e.target.value ? Number(e.target.value) : '' })}>
                  <option value="">请选择</option>
                  {(mine.data ?? [])
                    .filter((d) => d.docType === 'contract' && d.status === 'to_execute')
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.bizNo} {d.title}
                      </option>
                    ))}
                </Select>
              </Field>
            )}
            {(f.sealKind === 'license_e' || f.sealKind === 'license_paper') && (
              <Field label="证照">
                <Select value={f.licenseId} onChange={(e) => set({ licenseId: e.target.value ? Number(e.target.value) : '' })}>
                  <option value="">请选择</option>
                  {licenses
                    .filter((l) => (l.kind === 'electronic') === (f.sealKind === 'license_e'))
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </Select>
              </Field>
            )}
            {check('高风险 / 超授权', 'highRisk')}
            <Field label="用途" className="sm:col-span-2">
              <Textarea rows={2} value={f.purpose} onChange={(e) => set({ purpose: e.target.value })} />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}
