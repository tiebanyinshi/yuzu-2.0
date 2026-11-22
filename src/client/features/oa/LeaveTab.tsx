// OA-09 后台「考勤设置 → 假种与余额」（docs/OA.md 第 12 节）：人事（hr.attendance）管假种规则、看与调整员工的假期余额。
//   · 假种：带薪、要证明附件、管余额、年假按工龄分档；新建带操作编号（结果不确定的在页面上方查回、按原内容重提或确认作废），修改带版本。
//   · 余额：选年度看本店员工各「管余额」假种的发放、已用、剩余；调整（加或减、写原因）带操作编号；「按规则发放今年年假」立刻跑一次自动发放。
//   · 单位半天：页面上按天填，可以填 .5。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Plus } from 'lucide-react';
import { halvesText, LEAVE_NAME_MAX, LEAVE_REASON_MAX, type LeaveAdjustSaved, type LeaveEntry, type LeaveTier, type LeaveType, type LeaveTypeSaved, type LeaveYear } from '@shared/oa';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, Select, Skeleton, Textarea } from '../../components/ui';
import { EntryList } from './LeaveEntryList';

const KEY = ['oa', 'leave'] as const;

/** 工龄分档写成「满 1 年 5 天、满 10 年 10 天」 */
const tiersText = (t: LeaveTier[] | null) => (t ? t.map((x) => `满 ${x.years} 年 ${x.days} 天`).join('、') : '—');
/** 「满 1 年 5 天」一行一档的文本 ↔ 分档 */
const tiersInput = (t: LeaveTier[] | null) => (t ? t.map((x) => `${x.years} ${x.days}`).join('\n') : '');
function parseTiers(text: string): LeaveTier[] | null | 'bad' {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const out: LeaveTier[] = [];
  for (const l of lines) {
    const m = /^(\d{1,2})\s+(\d{1,2})$/.exec(l);
    if (!m) return 'bad';
    out.push({ years: Number(m[1]), days: Number(m[2]) });
  }
  return out;
}

export function LeaveTab() {
  const qc = useQueryClient();
  const [year, setYear] = useState<number | null>(null);
  const q = useQuery({ queryKey: [...KEY, year], queryFn: () => api.get<LeaveYear>(`/api/oa/leave/balances${year ? `?year=${year}` : ''}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  return (
    <div className="space-y-4" data-testid="leave-tab">
      {/* 新建假种、调整余额没收到结果的：查回、按原内容重新提交或确认作废 */}
      <ErpPendingPanel types={['oa_leave_type', 'oa_leave_adjust']} className="space-y-2" onFound={refresh} />
      {q.isPending ? (
        <Skeleton className="h-72" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="假种与余额没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <TypesCard types={q.data!.types} />
          <BalancesCard data={q.data!} onYear={setYear} />
        </>
      )}
    </div>
  );
}

function TypesCard({ types }: { types: LeaveType[] }) {
  const [editing, setEditing] = useState<LeaveType | 'new' | null>(null);
  const yes = (v: boolean) => (v ? '是' : '—');
  const columns: DataColumn<LeaveType>[] = [
    { key: 'name', header: '假种', cell: (t) => <span className="font-bold">{t.name}</span> },
    { key: 'paid', header: '带薪', cell: (t) => yes(t.paid) },
    { key: 'proof', header: '要证明', cell: (t) => yes(t.proofRequired) },
    { key: 'balance', header: '管余额', cell: (t) => yes(t.hasBalance) },
    { key: 'tiers', header: '按工龄发放', cell: (t) => <span className="text-[12.5px] text-ink-2">{tiersText(t.annualTiers)}</span>, className: 'max-md:hidden' },
    { key: 'status', header: '状态', cell: (t) => (t.active ? <Badge tone="pine">启用</Badge> : <Badge tone="clay">已停用</Badge>) },
    {
      key: 'edit',
      header: '',
      align: 'right',
      cell: (t) => (
        <Button size="sm" variant="ghost" onClick={() => setEditing(t)} data-testid={`leave-type-edit-${t.name}`}>
          编辑
        </Button>
      ),
    },
  ];
  return (
    <Card className="p-5" data-testid="leave-types">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-bold text-ink">假种</h2>
          <p className="mt-0.5 text-[13px] text-ink-3">管余额的请假要有余额（审批通过后扣）；按工龄发放的每年自动发一次。不删只停用。</p>
        </div>
        <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="leave-type-new">
          新建假种
        </Button>
      </div>
      <DataTable columns={columns} rows={types} rowKey={(t) => t.id} empty="还没有假种" testId="leave-type-list" />
      <TypeDialog target={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function TypeDialog({ target, onClose }: { target: LeaveType | 'new' | null; onClose: () => void }) {
  const existing = target && target !== 'new' ? target : null;
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const pending = useErpRecorded(['oa_leave_type']);
  const [name, setName] = useState('');
  const [paid, setPaid] = useState(true);
  const [proof, setProof] = useState(false);
  const [hasBalance, setHasBalance] = useState(false);
  const [tiers, setTiers] = useState('');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(
    !!target,
    () => {
      setName(existing?.name ?? '');
      setPaid(existing?.paid ?? true);
      setProof(existing?.proofRequired ?? false);
      setHasBalance(existing?.hasBalance ?? false);
      setTiers(tiersInput(existing?.annualTiers ?? null));
      setActive(existing?.active ?? true);
      setError(null);
    },
    [target],
  );
  const parsed = parseTiers(tiers);
  const problem = !name.trim() ? '请填写假种名称' : parsed === 'bad' ? '按工龄发放：一行一档，写「满几年 给几天」两个数，中间空格' : parsed && !hasBalance ? '按工龄发放的假种要管余额' : null;
  const submit = async () => {
    if (problem || parsed === 'bad') return;
    if (!existing && pending.length > 0) {
      setError('上一次新建结果待确认：请先关掉这个窗口，在页面上方查回、按原内容重新提交或作废');
      return;
    }
    const body = { name: name.trim(), paid, proofRequired: proof, hasBalance, annualTiers: parsed, active, sort: existing?.sort ?? 0, version: existing?.version };
    setSaving(true);
    setError(null);
    try {
      if (existing) await api.put<LeaveTypeSaved>(`/api/oa/leave/types/${existing.id}`, body);
      else {
        const key = uuid();
        await sendErpOp<LeaveTypeSaved>({
          key,
          type: 'oa_leave_type',
          url: '/api/oa/leave/types',
          body: { ...body, clientKey: key },
          summary: `新建假种「${body.name}」`,
          staffName: session.staff.displayName,
        });
      }
      toast({ tone: 'success', title: `假种「${body.name}」已保存` });
      onClose();
    } catch (err) {
      if (err instanceof UncertainError) {
        toast({
          tone: 'info',
          title: existing ? `${err.message}，不确定有没有保存上` : '新建结果待确认',
          body: existing ? '已重新载入，请核对列表里是不是已经改好' : '已记在本机：请在页面上方查回、按原内容重新提交或作废，确认前不要重新填一份。',
        });
        onClose();
      } else if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        toast({ tone: 'info', title: errorMessage(err), body: '已载入最新内容，请核对后再改' });
        onClose();
      } else if (err instanceof ErpPendingStoreError) setError(err.message);
      else setError(errorMessage(err));
    } finally {
      setSaving(false);
      void qc.invalidateQueries({ queryKey: KEY });
    }
  };
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={existing ? `编辑假种 · ${existing.name}` : '新建假种'}
      footer={
        <>
          {(error || problem) && <span className="mr-auto self-center text-[13px] text-clay">{error ?? problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={() => void submit()} data-testid="leave-type-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="名称">
          <Input value={name} maxLength={LEAVE_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="如 丧假、调休" data-testid="leave-type-name" />
        </Field>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <ConfirmCheck checked={paid} onChange={setPaid}>
            带薪
          </ConfirmCheck>
          <ConfirmCheck checked={proof} onChange={setProof}>
            请假要证明附件
          </ConfirmCheck>
          <ConfirmCheck checked={hasBalance} onChange={setHasBalance}>
            管余额
          </ConfirmCheck>
          <ConfirmCheck checked={active} onChange={setActive}>
            启用
          </ConfirmCheck>
        </div>
        <Field label="按工龄发放（可不填）" hint="一行一档：满几年 给几天，如「1 5」「10 10」；填了每年按入职日期自动发">
          <Textarea className="min-h-24" value={tiers} onChange={(e) => setTiers(e.target.value)} placeholder={'1 5\n10 10\n20 15'} data-testid="leave-type-tiers" />
        </Field>
      </div>
    </Dialog>
  );
}

type StaffRow = LeaveYear['staff'][number];

function BalancesCard({ data, onYear }: { data: LeaveYear; onYear: (y: number) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adjusting, setAdjusting] = useState<StaffRow | null>(null);
  const [viewing, setViewing] = useState<StaffRow | null>(null);
  const [granting, setGranting] = useState(false);
  const types = data.types.filter((t) => t.hasBalance);
  const now = new Date().getFullYear();
  const grant = async () => {
    setGranting(true);
    try {
      const r = await api.post<{ granted: number }>('/api/oa/leave/grant', {});
      toast({ tone: 'success', title: r.granted ? `发放了 ${r.granted} 人次` : '没有要发的（发过的不重复发；没填入职日期、不满一年的不发）' });
    } catch (e) {
      toast({ tone: e instanceof UncertainError ? 'info' : 'error', title: errorMessage(e), body: e instanceof UncertainError ? '发放不会重复，可以放心再点一次' : undefined });
    } finally {
      setGranting(false);
      void qc.invalidateQueries({ queryKey: KEY });
    }
  };
  const columns: DataColumn<StaffRow>[] = [
    { key: 'name', header: '员工', className: 'whitespace-nowrap', cell: (s) => <span className="font-semibold text-ink">{s.staffName}</span> },
    { key: 'hire', header: '入职日期', className: 'num whitespace-nowrap max-md:hidden', cell: (s) => s.hireDate ?? <span className="text-ink-4">没填</span> },
    ...types.map(
      (t): DataColumn<StaffRow> => ({
        key: `t${t.id}`,
        header: `${t.name}（剩 / 发 / 用）`,
        className: 'num whitespace-nowrap',
        cellTestId: (s) => `leave-bal-${s.staffId}-${t.id}`,
        cell: (s) => {
          const b = s.balances.find((x) => x.leaveTypeId === t.id);
          if (!b) return '—';
          return (
            <span>
              <span className="font-semibold text-ink">{halvesText(b.grantedHalves - b.usedHalves)}</span>
              <span className="ml-1 text-[12px] text-ink-3">
                / {b.grantedHalves / 2} / {b.usedHalves / 2}
              </span>
            </span>
          );
        },
      }),
    ),
    {
      key: 'act',
      header: '',
      align: 'right',
      className: 'whitespace-nowrap',
      cell: (s) => (
        <span className="inline-flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setViewing(s)} data-testid={`leave-entries-${s.staffId}`}>
            明细
          </Button>
          {types.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setAdjusting(s)} data-testid={`leave-adjust-${s.staffId}`}>
              调整
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <Card className="p-5" data-testid="leave-balances">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-[16px] font-bold text-ink">假期余额</h2>
        <Select value={data.year} onChange={(e) => onYear(Number(e.target.value))} fullWidth={false} className="w-32" aria-label="年度" data-testid="leave-year">
          {[now - 1, now, now + 1].map((y) => (
            <option key={y} value={y}>
              {y} 年
            </option>
          ))}
        </Select>
        <Button variant="secondary" icon={<Gift className="size-4" />} loading={granting} onClick={() => void grant()} data-testid="leave-grant">
          按规则发放今年年假
        </Button>
      </div>
      <p className="mb-3 text-[12px] text-ink-3">单位：天（最小半天）。年假每小时自动发一次：在职、填了入职日期、满一年的才发，每人每年一次；不折算、不结转。</p>
      <DataTable columns={columns} rows={data.staff} rowKey={(s) => s.staffId} empty="本店还没有员工" testId="leave-balance-list" />
      <AdjustDialog staff={adjusting} year={data.year} types={types} onClose={() => setAdjusting(null)} />
      <EntriesDialog staff={viewing} year={data.year} onClose={() => setViewing(null)} />
    </Card>
  );
}

function AdjustDialog({ staff, year, types, onClose }: { staff: StaffRow | null; year: number; types: LeaveType[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const pending = useErpRecorded(['oa_leave_adjust']);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [sign, setSign] = useState<1 | -1>(1);
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(
    !!staff,
    () => {
      setTypeId(types[0]?.id ?? null);
      setSign(1);
      setDays('');
      setReason('');
      setError(null);
    },
    [staff],
  );
  const halves = /^\d{1,3}(\.[05])?$/.test(days.trim()) ? Math.round(Number(days) * 2) : null;
  const problem = !typeId ? '请选假种' : !halves ? '天数按半天填，如 1、2.5' : !reason.trim() ? '请填写调整原因' : null;
  const submit = async () => {
    if (problem || !staff || !halves || !typeId) return;
    if (pending.length > 0) {
      setError('上一次调整结果待确认：请先关掉这个窗口，在页面上方查回、按原内容重新提交或作废');
      return;
    }
    const type = types.find((t) => t.id === typeId)!;
    const key = uuid();
    setSaving(true);
    setError(null);
    try {
      await sendErpOp<LeaveAdjustSaved>({
        key,
        type: 'oa_leave_adjust',
        url: '/api/oa/leave/adjust',
        body: { clientKey: key, storeId: session.store.id, staffId: staff.staffId, leaveTypeId: typeId, year, halves: sign * halves, reason: reason.trim() },
        summary: `${staff.staffName} ${year} 年${type.name}${sign > 0 ? '加' : '减'} ${halvesText(halves)}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: `${staff.staffName}的${type.name}已调整` });
      onClose();
    } catch (err) {
      if (err instanceof UncertainError) {
        toast({ tone: 'info', title: '调整结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，确认前不要重新调一次。' });
        onClose();
      } else if (err instanceof ErpPendingStoreError) setError(err.message);
      else setError(errorMessage(err));
    } finally {
      setSaving(false);
      void qc.invalidateQueries({ queryKey: KEY });
    }
  };
  return (
    <Dialog
      open={!!staff}
      onClose={onClose}
      title={`调整假期余额 · ${staff?.staffName ?? ''}`}
      description={`${year} 年；减的不能超过剩余`}
      footer={
        <>
          {(error || problem) && <span className="mr-auto self-center text-[13px] text-clay">{error ?? problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={() => void submit()} data-testid="leave-adjust-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="假种">
          <Select value={typeId ?? ''} onChange={(e) => setTypeId(Number(e.target.value))} data-testid="leave-adjust-type">
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="加还是减">
          <Select value={sign} onChange={(e) => setSign(Number(e.target.value) as 1 | -1)} data-testid="leave-adjust-sign">
            <option value={1}>加</option>
            <option value={-1}>减</option>
          </Select>
        </Field>
        <Field label="天数" hint="最小半天">
          <Input value={days} onChange={(e) => setDays(e.target.value)} inputMode="decimal" placeholder="如 1、2.5" data-testid="leave-adjust-days" />
        </Field>
        <Field label="原因">
          <Input value={reason} maxLength={LEAVE_REASON_MAX} onChange={(e) => setReason(e.target.value)} placeholder="如 去年未休补发" data-testid="leave-adjust-reason" />
        </Field>
      </div>
    </Dialog>
  );
}

function EntriesDialog({ staff, year, onClose }: { staff: StaffRow | null; year: number; onClose: () => void }) {
  const q = useQuery({
    queryKey: [...KEY, 'entries', staff?.staffId, year],
    queryFn: () => api.get<LeaveEntry[]>(`/api/oa/leave/entries?staffId=${staff!.staffId}&year=${year}`),
    enabled: !!staff,
  });
  return (
    <Dialog open={!!staff} onClose={onClose} title={`${year} 年假期明细 · ${staff?.staffName ?? ''}`}>
      {q.isPending ? <Skeleton className="h-32" /> : q.isError && !q.data ? <LoadFailed title="明细没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} /> : <EntryList entries={q.data!} />}
    </Dialog>
  );
}
