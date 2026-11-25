// 员工办公 v1.1 第 2 批：排班授权管理页（docs/OA_MOBILE.md 第 5 节；需求文档 5.2）。
//   · 考勤管理员（hr.attendance）与部门经理可把本范围的查看 / 编排 / 发布排班权限授给下属（主管 / 部长 / 指定员工）。
//   · 不可转授（权限点不含授权权）；默认有效期 1 年；被授权人调岗自动失效；支持随时撤销；全程记审计。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck } from 'lucide-react';
import { shiftDate } from '@shared/labels';
import {
  SCHEDULE_GRANT_DEFAULT_DAYS,
  SCHEDULE_GRANT_NOTE_MAX,
  SCHEDULE_GRANT_PERM_LABELS,
  SCHEDULE_GRANT_PERMS,
  SCHEDULE_GRANT_STATUS_LABELS,
  SCHEDULE_SCOPE_LABELS,
  SCHEDULE_SCOPE_TYPES,
  type ScheduleGrant,
  type ScheduleGrantPage,
  type ScheduleGrantPerm,
  type ScheduleGrantSaved,
  type ScheduleGrantStatus,
  type ScheduleScopeType,
} from '@shared/oa';
import { positionLabel } from '@shared/positions';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { uuid } from '../../lib/utils';
import { DataTable } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, Notice, Select, Skeleton } from '../../components/ui';

const GRANTS_KEY = ['oa', 'schedule-grants'] as const;

const STATUS_TONE: Record<ScheduleGrantStatus, 'pine' | 'lake' | 'ink' | 'ember' | 'clay'> = {
  active: 'pine',
  pending: 'lake',
  expired: 'ink',
  transferred: 'ember',
  revoked: 'clay',
};

function scopeText(g: ScheduleGrant): string {
  if (g.scopeType === 'all_company') return '全公司';
  if (g.scopeType === 'group') return `考勤组：${g.scopeGroupName ?? `#${g.scopeGroupId}`}`;
  if (g.scopeType === 'dept') return `部门：${g.scopeDeptName ?? g.scopeDeptKey}`;
  if (g.scopeType === 'dept_tree') return `部门及下级：${g.scopeDeptName ?? g.scopeDeptKey}`;
  const names = g.scopeStaffNames.slice(0, 4).join('、');
  return `指定员工：${names}${g.scopeStaffNames.length > 4 ? ` 等 ${g.scopeStaffNames.length} 人` : ''}`;
}

export function ScheduleGrantsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const q = useQuery({ queryKey: GRANTS_KEY, queryFn: () => api.get<ScheduleGrantPage>('/api/oa/attendance/schedule-grants') });
  const data = q.data;
  const mine = (op: { staffId?: number }) => data?.access.builtInRole === 'hr' || op.staffId === session.staff.id;
  const pending = useErpRecorded(['oa_schedule_grant']).filter(mine);
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ScheduleGrant | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const list = data?.grants ?? [];
    if (filter === 'active') return list.filter((g) => g.status === 'active' || g.status === 'pending');
    if (filter === 'inactive') return list.filter((g) => g.status !== 'active' && g.status !== 'pending');
    return list;
  }, [data?.grants, filter]);

  const doRevoke = async () => {
    if (!revoking) return;
    if (pending.length > 0) {
      setRevokeError('上一次排班授权或撤销结果待确认：请先在页面上方查回、重提或作废');
      return;
    }
    setRevokeBusy(true);
    setRevokeError(null);
    const key = uuid();
    const target = revoking;
    try {
      const res = await sendErpOp<ScheduleGrantSaved>({
        key,
        type: 'oa_schedule_grant',
        url: `/api/oa/attendance/schedule-grants/${target.id}/revoke`,
        body: { clientKey: key, storeId: session.store.id, reason: revokeReason.trim() },
        summary: `撤销排班授权 · ${target.granteeName}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: res.replayed ? `「${target.granteeName}」的排班授权已撤销` : `已撤销「${target.granteeName}」的排班授权` });
      setRevoking(null);
      setRevokeReason('');
      void qc.invalidateQueries({ queryKey: GRANTS_KEY });
      void qc.invalidateQueries({ queryKey: ['oa', 'schedule'] });
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '撤销结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废。' });
        setRevoking(null);
        setRevokeReason('');
        void qc.invalidateQueries({ queryKey: GRANTS_KEY });
        void qc.invalidateQueries({ queryKey: ['oa', 'schedule'] });
      } else if (e instanceof ErpPendingStoreError) setRevokeError(e.message);
      else setRevokeError(errorMessage(e));
    } finally {
      setRevokeBusy(false);
    }
  };

  if (q.isPending) return <Skeleton className="h-72" />;
  if (q.isError && !data) return <LoadFailed title="排班授权记录没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />;
  if (!data) return null;

  return (
    <Card className="p-5" data-testid="att-schedule-grants">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-[15px] font-bold text-ink">
            <ShieldCheck className="size-4 text-pine" />
            排班授权
          </p>
          <p className="text-[13px] text-ink-3">
            {data.access.builtInRole === 'hr'
              ? '考勤管理员可向本店员工授出查看、编排或发布排班权限；被授权人不可转授，调岗或到期自动失效。'
              : '部门经理可在本部门及下级部门范围内把排班权限授给主管或指定员工；不可转授，调岗或到期自动失效。'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'active' | 'inactive')} fullWidth={false} className="w-32" aria-label="按状态筛选">
            <option value="all">全部状态</option>
            <option value="active">生效中 / 未生效</option>
            <option value="inactive">已失效 / 已撤销</option>
          </Select>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="grant-add-btn">
            新增授权
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="还没有排班授权记录" description="点右上角「新增授权」，可把本范围的排班查看、编排或发布权限授给主管或指定同事。" />
      ) : (
        <DataTable
          columns={[
            {
              key: 'grantee',
              header: '被授权人',
              cell: (g) => (
                <div>
                  <p className="font-semibold text-ink">{g.granteeName}</p>
                  <p className="text-[12px] text-ink-3">
                    授权时：{positionLabel(g.granteePosition)}
                    {g.granteeCurrentPosition !== g.granteePosition && <span className="ml-1 text-ember">（现：{g.granteeCurrentPosition ? positionLabel(g.granteeCurrentPosition) : '未设岗'}）</span>}
                  </p>
                </div>
              ),
            },
            {
              key: 'perms',
              header: '权限点',
              cell: (g) => (
                <div className="flex flex-wrap gap-1">
                  {g.permissions.map((p) => (
                    <Badge key={p} tone={p === 'publish' ? 'pine' : p === 'edit' ? 'lake' : 'ink'}>
                      {SCHEDULE_GRANT_PERM_LABELS[p]}
                    </Badge>
                  ))}
                </div>
              ),
            },
            {
              key: 'scope',
              header: '授权范围',
              cell: (g) => (
                <div className="text-[13px] text-ink-2">
                  <p>{scopeText(g)}</p>
                  {g.scopeCapDepts && <p className="text-[12px] text-ink-3">限部门范围内成员</p>}
                </div>
              ),
            },
            {
              key: 'valid',
              header: '有效期',
              cell: (g) => (
                <span className="num text-[13px] text-ink-2">
                  {g.validFrom} 至 {g.validTo}
                </span>
              ),
            },
            {
              key: 'status',
              header: '状态',
              cell: (g) => (
                <div>
                  <Badge tone={STATUS_TONE[g.status]}>{SCHEDULE_GRANT_STATUS_LABELS[g.status]}</Badge>
                  {g.revokeReason && <p className="mt-0.5 text-[12px] text-ink-3">{g.revokeReason}</p>}
                </div>
              ),
            },
            {
              key: 'grantor',
              header: '授权人与备注',
              cell: (g) => (
                <div className="text-[12.5px] text-ink-3">
                  <p className="text-ink-2">{g.grantorName}</p>
                  {g.note && <p>{g.note}</p>}
                </div>
              ),
            },
            {
              key: 'ops',
              header: '操作',
              cell: (g) =>
                g.canRevoke ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRevoking(g);
                      setRevokeReason('');
                      setRevokeError(null);
                    }}
                    data-testid={`grant-revoke-${g.id}`}
                  >
                    撤销
                  </Button>
                ) : (
                  <span className="text-[12px] text-ink-4">—</span>
                ),
            },
          ]}
          rows={rows}
          rowKey={(g) => g.id}
          testId="schedule-grants-table"
        />
      )}

      <CreateGrantDialog
        open={creating}
        data={data}
        selfId={session.staff.id}
        blocked={pending.length > 0}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          void qc.invalidateQueries({ queryKey: GRANTS_KEY });
          void qc.invalidateQueries({ queryKey: ['oa', 'schedule'] });
        }}
      />

      <Dialog
        open={!!revoking}
        onClose={revokeBusy ? () => {} : () => setRevoking(null)}
        title={revoking ? `撤销排班授权 · ${revoking.granteeName}` : ''}
        description="撤销后立即生效，对方不再拥有这条授权带来的排班权限；原授权与撤销记录均保留在审计日志中。"
        footer={
          <>
            <Button variant="secondary" size="lg" onClick={() => setRevoking(null)} disabled={revokeBusy}>
              取消
            </Button>
            <Button variant="danger" size="lg" loading={revokeBusy} onClick={() => void doRevoke()} data-testid="grant-revoke-confirm">
              确认撤销
            </Button>
          </>
        }
      >
        {revokeError && (
          <Notice tone="error" title="撤销失败" className="mb-3">
            {revokeError}
          </Notice>
        )}
        <Field label="撤销原因（选填）">
          <Input
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            maxLength={SCHEDULE_GRANT_NOTE_MAX}
            placeholder="例如：分工调整、不再负责排班"
            data-testid="grant-revoke-reason"
          />
        </Field>
      </Dialog>
    </Card>
  );
}

function CreateGrantDialog({
  open,
  data,
  selfId,
  blocked,
  onClose,
  onCreated,
}: {
  open: boolean;
  data: ScheduleGrantPage;
  selfId: number;
  blocked: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const isHr = data.access.builtInRole === 'hr';
  const grantees = useMemo(() => data.candidates.filter((c) => c.staffId !== selfId), [data.candidates, selfId]);
  const allowedScopes = useMemo(() => SCHEDULE_SCOPE_TYPES.filter((s) => isHr || s !== 'all_company'), [isHr]);

  const [granteeId, setGranteeId] = useState<number | ''>('');
  const [perms, setPerms] = useState<ScheduleGrantPerm[]>(['view', 'edit']);
  const [scopeType, setScopeType] = useState<ScheduleScopeType>('group');
  const [scopeGroupId, setScopeGroupId] = useState<number | ''>('');
  const [scopeDeptKey, setScopeDeptKey] = useState('');
  const [scopeStaffIds, setScopeStaffIds] = useState<number[]>([]);
  const [validFrom, setValidFrom] = useState(data.today);
  const [validTo, setValidTo] = useState(shiftDate(data.today, SCHEDULE_GRANT_DEFAULT_DAYS));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useResetOnOpen(open, () => {
    setGranteeId(grantees[0]?.staffId ?? '');
    setPerms(['view', 'edit']);
    setScopeType(data.groups.length > 0 ? 'group' : 'dept');
    setScopeGroupId(data.groups[0]?.id ?? '');
    setScopeDeptKey(data.departments[0]?.key ?? '');
    setScopeStaffIds([]);
    setValidFrom(data.today);
    setValidTo(shiftDate(data.today, SCHEDULE_GRANT_DEFAULT_DAYS));
    setNote('');
    setError(null);
  }, [open]);

  const togglePerm = (p: ScheduleGrantPerm) => {
    setPerms((cur) => {
      const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
      if ((next.includes('edit') || next.includes('publish')) && !next.includes('view')) next.push('view');
      return next;
    });
  };
  const toggleStaff = (id: number) => setScopeStaffIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = async () => {
    if (blocked) {
      setError('上一次排班授权结果待确认：请先在页面上方查回、重提或作废');
      return;
    }
    if (!granteeId) return setError('请选择被授权员工');
    if (perms.length === 0) return setError('请至少勾选一项排班权限');
    if (scopeType === 'group' && !scopeGroupId) return setError('请选择考勤组');
    if ((scopeType === 'dept' || scopeType === 'dept_tree') && !scopeDeptKey) return setError('请选择部门');
    if (scopeType === 'staff' && scopeStaffIds.length === 0) return setError('请至少勾选一位范围员工');
    setSaving(true);
    setError(null);
    const key = uuid();
    const granteeName = grantees.find((g) => g.staffId === granteeId)?.name ?? '';
    try {
      const res = await sendErpOp<ScheduleGrantSaved>({
        key,
        type: 'oa_schedule_grant',
        url: '/api/oa/attendance/schedule-grants',
        body: {
          clientKey: key,
          storeId: session.store.id,
          granteeStaffId: Number(granteeId),
          permissions: perms,
          scopeType,
          ...(scopeType === 'group' ? { scopeGroupId: Number(scopeGroupId) } : {}),
          ...(scopeType === 'dept' || scopeType === 'dept_tree' ? { scopeDeptKey } : {}),
          ...(scopeType === 'staff' ? { scopeStaffIds } : {}),
          validFrom,
          validTo,
          note: note.trim(),
        },
        summary: `排班授权 · ${granteeName}（${SCHEDULE_SCOPE_LABELS[scopeType]}）`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: res.replayed ? '排班授权已建好' : `已向「${res.grant.granteeName}」授出排班权限` });
      onCreated();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '排班授权结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废。' });
        onCreated();
      } else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? () => {} : onClose}
      title="新增排班授权"
      description="仅可授出查看、编排、发布权限，被授权人不可转授；调岗或过期自动失效。"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} onClick={() => void submit()} data-testid="grant-submit">
            确认授权
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="grant-dialog">
        {error && (
          <Notice tone="error" title="没有授出">
            <span data-testid="grant-error">{error}</span>
          </Notice>
        )}
        <Field label="被授权员工">
          <Select value={granteeId} onChange={(e) => setGranteeId(e.target.value ? Number(e.target.value) : '')} data-testid="grant-grantee">
            <option value="">请选择员工</option>
            {grantees.map((c) => (
              <option key={c.staffId} value={c.staffId}>
                {c.name}（{positionLabel(c.position)}）
              </option>
            ))}
          </Select>
        </Field>

        <Field label="授出权限点（不可转授；编排或发布自动含查看）">
          <div className="space-y-2">
            {SCHEDULE_GRANT_PERMS.map((p) => (
              <ConfirmCheck key={p} checked={perms.includes(p)} onChange={() => togglePerm(p)}>
                <span data-testid={`grant-perm-${p}`}>{SCHEDULE_GRANT_PERM_LABELS[p]}</span>
              </ConfirmCheck>
            ))}
          </div>
        </Field>

        <Field label="授权范围">
          <Select value={scopeType} onChange={(e) => setScopeType(e.target.value as ScheduleScopeType)} data-testid="grant-scope-type">
            {allowedScopes.map((s) => (
              <option key={s} value={s}>
                {SCHEDULE_SCOPE_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>

        {scopeType === 'group' && (
          <Field label="选择考勤组">
            <Select value={scopeGroupId} onChange={(e) => setScopeGroupId(e.target.value ? Number(e.target.value) : '')} data-testid="grant-scope-group">
              <option value="">请选择考勤组</option>
              {data.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {(scopeType === 'dept' || scopeType === 'dept_tree') && (
          <Field label="选择部门">
            <Select value={scopeDeptKey} onChange={(e) => setScopeDeptKey(e.target.value)} data-testid="grant-scope-dept">
              <option value="">请选择部门</option>
              {data.departments.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {scopeType === 'staff' && (
          <Field label={`勾选范围员工（已选 ${scopeStaffIds.length} 人）`}>
            <div className="max-h-44 space-y-1.5 overflow-y-auto rounded-md border border-line p-2">
              {data.candidates.map((c) => (
                <ConfirmCheck key={c.staffId} checked={scopeStaffIds.includes(c.staffId)} onChange={() => toggleStaff(c.staffId)}>
                  <span data-testid={`grant-scope-staff-${c.staffId}`}>
                    {c.name}（{positionLabel(c.position)}）
                  </span>
                </ConfirmCheck>
              ))}
            </div>
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="生效开始日期">
            <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} data-testid="grant-valid-from" />
          </Field>
          <Field label="生效截止日期（默认一年）">
            <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} data-testid="grant-valid-to" />
          </Field>
        </div>

        <Field label="备注（选填）">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={SCHEDULE_GRANT_NOTE_MAX} placeholder="例如：前厅主管负责早晚班排班" data-testid="grant-note" />
        </Field>
      </div>
    </Dialog>
  );
}
