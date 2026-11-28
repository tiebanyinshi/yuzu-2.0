// 员工小程序 · 管理（后台「WCP 设置 → 人员与行政 → 员工小程序」，员工小程序线，docs/STAFF_MP.md 第 6、8.1 节）：
//   · 状态：开关（SP12，默认开）、这台门店系统开没开员工小程序端口、微信一键登录配没配；
//   · 谁绑了微信：姓名、岗位、绑定时间、最近一次登录、还有几个没过期的小程序会话；「解开」以后这个人在小程序上的会话全部退出；
//   · 饭卡对上（第 5.4 节）：员工账号与柚子饭堂名单里的人对上，饭卡码才亮得出来；按人事档案的手机号找到的可以一键对上，对错的解开。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { StaffMpAdminView, StaffMpBindingRow, StaffMpCanteenLinkRow } from '@shared/staffmp';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, InfoItem, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';

const KEY = ['staffmp', 'admin'] as const;
const LINKS_KEY = ['staffmp', 'canteen-links'] as const;
const METHOD_LABELS: Record<NonNullable<StaffMpCanteenLinkRow['linked']>['method'], string> = { admin: '后台对上', password: '员工用饭堂账号对上', created: '在小程序开通' };

export function StaffMpSection() {
  const toast = useToast();
  const qc = useQueryClient();
  const view = useQuery({ queryKey: KEY, queryFn: () => api.get<StaffMpAdminView>('/api/admin/staffmp') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState<StaffMpBindingRow | null>(null);
  const links = useQuery({ queryKey: LINKS_KEY, queryFn: () => api.get<StaffMpCanteenLinkRow[]>('/api/admin/staffmp/canteen-links') });
  const [unlinking, setUnlinking] = useState<StaffMpCanteenLinkRow | null>(null);
  const suggested = (links.data ?? []).filter((r) => !r.linked && r.suggestion);

  /** 对上按手机号找到的（一位或全部）：已经对上的、饭卡已经对给别人的跳过 */
  const linkSuggested = async (rows: StaffMpCanteenLinkRow[]) => {
    setBusy(true);
    setError('');
    try {
      const pairs = rows.flatMap((r) => (r.suggestion ? [{ staffId: r.staffId, employeeId: r.suggestion.employeeId }] : []));
      const res = await api.post<{ linked: number; skipped: number }>('/api/admin/staffmp/canteen-links', { pairs });
      await qc.invalidateQueries({ queryKey: LINKS_KEY });
      toast({ tone: 'success', title: `对上了 ${res.linked} 位${res.skipped ? `，${res.skipped} 位已经对上或饭卡给了别人，跳过` : ''}` });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (row: StaffMpCanteenLinkRow) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/admin/staffmp/canteen-links/${row.staffId}/unlink`);
      await qc.invalidateQueries({ queryKey: LINKS_KEY });
      setUnlinking(null);
      toast({ tone: 'success', title: `已解开「${row.displayName}」的饭卡` });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      await api.put('/api/admin/staffmp/settings', { enabled });
      await qc.invalidateQueries({ queryKey: KEY });
      toast({ tone: 'success', title: enabled ? '员工小程序打开了' : '员工小程序暂停了：员工打开会看到「暂停使用」' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (row: StaffMpBindingRow) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/admin/staffmp/bindings/${row.id}/revoke`);
      await qc.invalidateQueries({ queryKey: KEY });
      setRevoking(null);
      toast({ tone: 'success', title: `已解开「${row.displayName}」的微信，这位员工在小程序上的登录都退出了` });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const columns: DataColumn<StaffMpBindingRow>[] = [
    { key: 'name', header: '员工', cell: (r) => r.displayName, dataLabel: '员工' },
    { key: 'username', header: '账号', cell: (r) => r.username, dataLabel: '账号' },
    { key: 'position', header: '岗位', cell: (r) => r.positionTitle ?? '—', dataLabel: '岗位' },
    { key: 'bound', header: '绑定时间', cell: (r) => formatDateTime(r.boundAt), dataLabel: '绑定时间' },
    { key: 'last', header: '最近一次登录', cell: (r) => (r.lastLoginAt ? formatDateTime(r.lastLoginAt) : '—'), dataLabel: '最近一次登录' },
    { key: 'live', header: '在用的登录', numeric: true, cell: (r) => r.liveSessions, dataLabel: '在用的登录' },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <Button variant="secondary" size="sm" onClick={() => setRevoking(r)} data-testid={`staffmp-revoke-${r.id}`}>
          解开
        </Button>
      ),
    },
  ];

  const linkColumns: DataColumn<StaffMpCanteenLinkRow>[] = [
    { key: 'name', header: '员工', cell: (r) => r.displayName, dataLabel: '员工' },
    { key: 'phone', header: '人事档案手机号', cell: (r) => r.phone ?? '—', dataLabel: '手机号' },
    {
      key: 'card',
      header: '饭卡',
      cell: (r) =>
        r.linked ? (
          <span>
            {r.linked.name}（{r.linked.empNo}）<span className="ml-2 text-xs text-ink-3">{METHOD_LABELS[r.linked.method]}</span>
          </span>
        ) : r.suggestion ? (
          <span className="text-ink-2">
            没对上 · 手机号对得上：{r.suggestion.name}（{r.suggestion.empNo}）
          </span>
        ) : (
          <span className="text-ink-3">没对上</span>
        ),
      dataLabel: '饭卡',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) =>
        r.linked ? (
          <Button variant="secondary" size="sm" onClick={() => setUnlinking(r)} data-testid={`staffmp-unlink-${r.staffId}`}>
            解开
          </Button>
        ) : r.suggestion ? (
          <Button variant="secondary" size="sm" onClick={() => void linkSuggested([r])} disabled={busy} data-testid={`staffmp-link-${r.staffId}`}>
            对上
          </Button>
        ) : null,
    },
  ];

  return (
    <AdminPage
      section="staffmp"
      wide
      description="员工用微信小程序「汤崎 WCP」打卡、看排班、审批、看工资条与培训资料。第一次用柚子的账号密码登录，之后同一个微信一键进；这里看谁绑了微信，换手机、离职、绑错了的可以解开。"
    >
      {view.isError ? (
        <LoadFailed title="员工小程序的设置没有取回来" onRetry={() => view.refetch()} retrying={view.isFetching} />
      ) : !view.data ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="space-y-5" data-testid="staffmp-section">
          {error && <Notice tone="error">{error}</Notice>}
          <Card className="space-y-4 p-5">
            <SectionTitle
              aside={
                <Button variant={view.data.enabled ? 'secondary' : 'primary'} onClick={() => void toggle(!view.data!.enabled)} disabled={busy} data-testid="staffmp-toggle">
                  {view.data.enabled ? '暂停使用' : '打开'}
                </Button>
              }
            >
              状态
            </SectionTitle>
            <div className="grid gap-4 sm:grid-cols-3">
              <InfoItem label="员工小程序">{view.data.enabled ? <Badge tone="pine">开着</Badge> : <Badge tone="ember">暂停使用</Badge>}</InfoItem>
              <InfoItem label="员工小程序端口">{view.data.portOpen ? '这台门店系统开着' : '没开（.env 没设 STAFFMP_PORT）'}</InfoItem>
              <InfoItem label="微信一键登录">{view.data.mockWechat ? '模拟微信（开发、测试环境）' : view.data.wechatConfigured ? `已配好（${view.data.appId}）` : '没配：只能账号密码登录'}</InfoItem>
            </div>
          </Card>

          <div>
            <SectionTitle>绑了微信的员工（{view.data.bindings.length}）</SectionTitle>
            <DataTable
              className="mt-3"
              columns={columns}
              rows={view.data.bindings}
              rowKey={(r) => r.id}
              rowTestId={(r) => `staffmp-binding-${r.staffId}`}
              empty="还没有员工绑微信"
              emptyDescription="员工在小程序里用账号密码登录一次、勾上「以后用这个微信直接进」就会出现在这里。"
            />
          </div>

          <div>
            <SectionTitle
              aside={
                suggested.length > 0 && (
                  <Button variant="secondary" onClick={() => void linkSuggested(suggested)} disabled={busy} data-testid="staffmp-link-all">
                    手机号对得上的 {suggested.length} 位都对上
                  </Button>
                )
              }
            >
              饭卡对上
            </SectionTitle>
            <p className="mt-1 text-sm text-ink-2">
              员工账号对上柚子饭堂名单里的人，小程序里的饭卡码才亮得出来。员工也可以自己在小程序里用饭堂账号对上，或者开通一张新饭卡；按手机号找到的请核对是同一个人再对上。
            </p>
            {links.isError ? (
              <LoadFailed className="mt-3" title="饭卡对上的名单没有取回来" onRetry={() => links.refetch()} retrying={links.isFetching} />
            ) : !links.data ? (
              <Skeleton className="mt-3 h-40" />
            ) : (
              <DataTable className="mt-3" columns={linkColumns} rows={links.data} rowKey={(r) => r.staffId} rowTestId={(r) => `staffmp-canteen-${r.staffId}`} empty="没有在职的员工" />
            )}
          </div>
        </div>
      )}

      <Dialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        title={`解开「${revoking?.displayName ?? ''}」的微信？`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRevoking(null)}>
              先不解开
            </Button>
            <Button variant="danger" onClick={() => revoking && void revoke(revoking)} disabled={busy} data-testid="staffmp-revoke-confirm">
              解开
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">解开以后，这位员工在小程序上的登录马上全部退出；下次要重新用账号密码登录，可以再绑。</p>
      </Dialog>

      <Dialog
        open={!!unlinking}
        onClose={() => setUnlinking(null)}
        title={`解开「${unlinking?.displayName ?? ''}」的饭卡？`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setUnlinking(null)}>
              先不解开
            </Button>
            <Button variant="danger" onClick={() => unlinking && void unlink(unlinking)} disabled={busy} data-testid="staffmp-unlink-confirm">
              解开
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">只解开员工账号与饭卡的对应，饭堂名单和吃饭记录都不动。解开以后这位员工要在小程序里重新对上饭卡。</p>
      </Dialog>
    </AdminPage>
  );
}
