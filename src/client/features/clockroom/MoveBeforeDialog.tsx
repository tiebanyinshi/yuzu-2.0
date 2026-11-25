// 排位调到某人前面（8.1.40，docs/V8140_B.md 第 3 节）：在同工种的在岗队列里选一位，把这位技师直接调到他前面；原因必填，记进钟房日志。
// 不是收款、不跨天，与「排尾」一样不带操作编号：结果不明时刷新看板看排位就知道调没调。

import { useState } from 'react';
import type { BoardTechnician, ClockroomBoard } from '@shared/clockroom';
import { api, errorMessage } from '../../lib/api';
import { useReasons } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { ReasonChips } from '../../components/ReasonChips';
import { Button, Field, Input, Notice } from '../../components/ui';

export function MoveBeforeDialog({
  technician,
  board,
  onClose,
  onDone,
}: {
  technician: BoardTechnician | null;
  board: ClockroomBoard;
  onClose: () => void;
  onDone: (board: ClockroomBoard, text: string) => void;
}) {
  const reasons = useReasons('queueMoveReasons');
  const [beforeId, setBeforeId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(!!technician, () => {
    setBeforeId(null);
    setReason('');
    setError(null);
  });
  if (!technician) return null;
  const kind = technician.kind.trim();
  // 同工种在岗的，按排位；自己和紧挨在自己后面的那位（调过去也不变）不列
  const queue = board.technicians.filter((t) => t.state === 'on' && t.position !== null && t.kind.trim() === kind).sort((a, b) => a.position! - b.position!);
  const after = queue[queue.findIndex((t) => t.id === technician.id) + 1];
  const options = queue.filter((t) => t.id !== technician.id && t.id !== after?.id);
  const target = options.find((t) => t.id === beforeId) ?? null;
  const trimmed = reason.trim();
  const problem = !target ? '请选调到哪位前面' : trimmed.length < 2 ? '请写原因（至少 2 个字）' : null;
  const label = `${technician.techNo} 号 ${technician.name}`;

  const submit = async () => {
    if (problem || !target) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.post<ClockroomBoard>(`/api/clockroom/technicians/${technician.id}/move-before`, { beforeId: target.id, reason: trimmed });
      onDone(next, `${technician.techNo} 号调到 ${target.techNo} 号前面`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={`调排位 · ${label}`}
      description={`在${kind ? `「${kind}」` : ''}队列里把他直接调到某位技师前面（只能调到同工种、在岗的人前面）；原因记进钟房日志。`}
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!problem} loading={busy} onClick={() => void submit()} data-testid="move-before-confirm">
            {target ? `调到 ${target.techNo} 号前面` : '调排位'}
          </Button>
        </>
      }
    >
      <Field label="调到谁前面">
        {options.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-ink-3">同工种没有别的在岗技师可以调</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="move-before-list">
            {options.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setBeforeId(t.id)}
                aria-pressed={beforeId === t.id}
                className={cn('tap relative flex flex-col rounded-lg border px-3 py-2 text-left', beforeId === t.id ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-line-strong')}
                data-testid={`move-before-${t.techNo}`}
              >
                <span className="flex items-baseline gap-1.5">
                  <span className="num text-[12px] font-bold text-ink-3">第 {t.position} 位</span>
                  <span className="num text-[16px] font-bold">{t.techNo}</span>
                  <span className="min-w-0 truncate font-bold">{t.name}</span>
                </span>
                <span className="text-[12px] text-ink-4">{t.busy ? (t.busy.status === 'serving' ? '在钟上' : '已有待上钟') : `今日 ${t.todayClocks} 钟`}</span>
              </button>
            ))}
          </div>
        )}
      </Field>
      <Field label="原因" htmlFor="move-before-reason" className="mt-3">
        <ReasonChips reasons={reasons} value={reason} onPick={setReason} disabled={busy} />
        <Input id="move-before-reason" value={reason} maxLength={100} placeholder="例如：补回刚才跳过的" onChange={(e) => setReason(e.target.value)} data-testid="move-before-reason" />
      </Field>
      {error && <Notice tone="error" title={error} className="mt-4" />}
    </Dialog>
  );
}
