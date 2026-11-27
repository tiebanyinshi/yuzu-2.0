// 返台补低消（8.2.4，docs/V8224_DINING.md 第 4 节）：包房低消没够时，转挂账的单或刚结了账（补了低消、还没清台）的单回到桌台继续点。
//   · 转挂账的：回到原来的桌台（桌台要空着）；
//   · 已结账的：同一笔里反结账那张结账单（收的钱照反结账退回：现金退、储值撤销……），结账时自动记的服务费、低消补足作废，再结账时重算；
//     要「返台」与「反结账」两项权限。
// 要写原因。这一次打开用同一个操作编号：没收到回复重点一次，服务端认得是同一笔、照第一次的结果返回，不会反结账两次。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import type { ReturnableSession } from '@shared/dining-v8224';
import { formatYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice, Skeleton } from '../../components/ui';

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
  const [key] = useState(uuid);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = byTable ? (found.data?.session?.sessionId ?? null) : target.sessionId;

  const submit = async () => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/dining/tables/sessions/${sessionId}/return`, { clientKey: key, reason: reason.trim() });
      void qc.invalidateQueries({ queryKey: ['dining'] });
      toast({ tone: 'success', title: '已返台', body: '回到桌台继续点，补到低消再结账' });
      onDone(sessionId);
    } catch (e) {
      // 没收到回复的：再点一次用的还是这个编号，服务端照第一次的结果返回
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
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
          <Button variant="primary" icon={<Undo2 className="size-4" />} loading={busy} disabled={!sessionId || reason.trim().length < 2} onClick={submit} data-testid="table-return-submit">
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
            placeholder="例如：客人还要点，补到低消"
            data-autofocus
            data-testid="table-return-reason"
          />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
