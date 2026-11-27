// 员工小程序 · 管理（后台「WCP 设置 → 人员与行政 → 员工小程序」，员工小程序线，docs/STAFF_MP.md 第 6、8.1 节）：
//   · 状态：开关（SP12，默认开）、这台门店系统开没开员工小程序端口、微信一键登录配没配；
//   · 谁绑了微信：姓名、岗位、绑定时间、最近一次登录、还有几个没过期的小程序会话；「解开」以后这个人在小程序上的会话全部退出。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { StaffMpAdminView, StaffMpBindingRow } from '@shared/staffmp';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, InfoItem, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';

const KEY = ['staffmp', 'admin'] as const;

export function StaffMpSection() {
  const toast = useToast();
  const qc = useQueryClient();
  const view = useQuery({ queryKey: KEY, queryFn: () => api.get<StaffMpAdminView>('/api/admin/staffmp') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState<StaffMpBindingRow | null>(null);

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
      toast({ tone: 'success', title: `已解开「${row.displayName}」的微信，他在小程序上的登录都退出了` });
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
        <p className="text-sm text-ink-2">解开以后，他在小程序上的登录马上全部退出；下次要重新用账号密码登录，可以再绑。</p>
      </Dialog>
    </AdminPage>
  );
}
