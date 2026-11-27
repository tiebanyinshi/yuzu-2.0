// 返台补低消（8.2.4，docs/V8224_DINING.md 第 4 节）：包房低消没够时，转挂账的单或刚结了账（补了低消、还没清台）的单回到桌台继续点。
//   · 转挂账的：回到原来的桌台（桌台要空着）；
//   · 已结账的：同一笔里反结账那张结账单（收的钱照反结账退回：现金退、储值撤销……），结账时自动记的服务费、低消补足作废，再结账时重算；
//     要「返台」与「反结账」两项权限。
// 要写原因。照前台的「结果待确认」（8.2.5，Codex 审查）：提交前本机存下操作编号与原请求（存不了就不发）；没收到回复时
// 关掉对话框、刷新也还在，顶部提醒能回到这里，只能查回、按原内容重新提交或确认作废（作废以后原请求整笔回滚，连反结账一起），
// 不会因为换了新编号反结账两次。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import type { ReturnableSession } from '@shared/dining-v8224';
import type { TableSessionDetail } from '@shared/dining';
import { formatYuan } from '@shared/money';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { useSession } from '../../lib/session';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice, Skeleton } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';

/** target：转挂账的单（开台编号），或待清台的桌（找上一次结了账、补了低消的那次开台） */
export function ReturnTableDialog({ target, onClose, onDone }: { target: { sessionId: number } | { tableId: number; tableName: string }; onClose: () => void; onDone: (sessionId: number) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const byTable = 'tableId' in target;
  const found = useQuery({
    queryKey: ['dining', 'tables-returnable', byTable ? target.tableId : 0],
    queryFn: () => api.get<{ session: ReturnableSession | null }>(`/api/dining/tables/${byTable ? target.tableId : 0}/returnable`),
    enabled: byTable,
  });
  const [reason, setReason] = useState('');
  const sessionId = byTable ? (found.data?.session?.sessionId ?? null) : target.sessionId;
  const label = byTable ? `桌 ${target.tableName}` : '这一桌';
  const session = useSession();
  const op = useFrontdeskOp<TableSessionDetail>({
    type: 'table_return',
    visitId: null,
    sessionId,
    staffName: session.staff.displayName,
    pick: (f) => (f.type === 'table_return' ? f.session : null),
  });
  const busy = op.busy;
  const done = (id: number) => {
    void qc.invalidateQueries({ queryKey: ['dining'] });
    toast({ tone: 'success', title: '已返台', body: '回到桌台继续点，补到低消再结账' });
    onDone(id);
  };

  const submit = async () => {
    if (!sessionId) return;
    const result = await op.submit((key) => ({
      url: `/api/dining/tables/sessions/${sessionId}/return`,
      body: { clientKey: key, reason: reason.trim() },
      tagCodes: [label],
      summary: `返台：${reason.trim()}`,
      amount: null,
    }));
    void qc.invalidateQueries({ queryKey: ['dining'] });
    if (result) done(sessionId);
  };

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={byTable ? `桌 ${target.tableName} 返台补低消` : '返台补低消'}
      description="只有低消没够的包房能返台：回到桌台继续点，补到低消再结账"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={<Undo2 className="size-4" />}
            loading={busy}
            disabled={!sessionId || reason.trim().length < 2 || op.locked}
            onClick={submit}
            data-testid="table-return-submit"
          >
            返台
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {byTable &&
          (found.isLoading ? (
            <Skeleton className="h-12" />
          ) : found.data?.session ? (
            <Notice tone="warning" title={`结账单 ${found.data.session.checkoutNo} 会反结账`}>
              {formatDateTime(found.data.session.checkedOutAt)} 结的账，补了低消 {formatYuan(found.data.session.topUp)}
              。返台以后这张结账单作废，收的钱按反结账退回（现金退给客人、储值撤销），这桌回到用餐中。
            </Notice>
          ) : (
            <Notice tone="info" title="这桌上一次结账没有补低消，不用返台" />
          ))}
        <Field label="返台原因" htmlFor="table-return-reason" hint="至少 2 个字，记在审计里">
          <Input
            id="table-return-reason"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            disabled={op.locked}
            placeholder="例如：客人还要点，补到低消"
            data-autofocus
            data-testid="table-return-reason"
          />
        </Field>
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
        <PendingPanel op={op} onResolved={(s) => done(s.id)} />
      </div>
    </Dialog>
  );
}
