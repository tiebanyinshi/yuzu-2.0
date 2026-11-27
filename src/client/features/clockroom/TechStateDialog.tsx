// 技师休假、停牌、复牌（8.0.8，B01）带操作编号、走「结果待确认」（合并前 Codex 审查 e2cb70d）：
// 发出前在本机记下编号与原请求；超时、断网、服务器出错时留在这里查回、原样重提或确认作废，
// 处理完之前这位技师不能另做停牌、复牌、休假、上牌等（迟到的原请求不会覆盖之后的操作）。
// 8.2.2：休假可以直接设天数——1 天照旧只管今天；2 天以上记成一张休假单（有名册权限的直接批准，没有的待技师管理批），
// 默认休完自动上牌、排到队尾（docs/V8222_TECHNICIANS.md 第 5 节）。

import { useState } from 'react';
import type { BoardTechnician, ClockroomBoard } from '@shared/clockroom';
import { LEAVE_MAX_DAYS, LEAVE_TYPE_LABELS, LEAVE_TYPES, type LeaveType } from '@shared/technician-admin';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { Button, ConfirmCheck, Field, Input, Notice, Select } from '../../components/ui';
import { QtyInput } from '../../components/QtyInput';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';

export type TechStateAction = 'leave' | 'suspend' | 'resume';

const TEXT: Record<TechStateAction, { title: string; description: string; confirm: string; reason: 'required' | 'optional' | 'none'; placeholder?: string }> = {
  leave: {
    title: '休假',
    description: '休假的不在排队里、不能派钟，「全部上牌」跳过他。休 1 天只管今天，上牌即取消休假；休几天的记成休假单，休完自动上牌、排到队尾。',
    confirm: '确认休假',
    reason: 'optional',
    placeholder: '选填，例如：调休、事假',
  },
  suspend: {
    title: '停牌',
    description: '停牌一直停到复牌（跨天）：停牌的不能上牌、不能派钟，「全部上牌」跳过他。原因记进钟房日志。',
    confirm: '确认停牌',
    reason: 'required',
    placeholder: '例如：迟到、培训、身体不适',
  },
  resume: { title: '复牌', description: '复牌以后回到未上牌，可以上牌、派钟。', confirm: '确认复牌', reason: 'none' },
};

export const TECH_STATE_DONE: Record<TechStateAction, string> = { leave: '今天休假', suspend: '已停牌', resume: '已复牌' };

const doneOnFound = () => true as const;

export function TechStateDialog({
  technician,
  action,
  onClose,
  onDone,
}: {
  technician: BoardTechnician | null;
  action: TechStateAction;
  onClose: () => void;
  /** 生效了：直接返回的新看板；查回、作废后为 null（按最新的看板刷新） */
  onDone: (board: ClockroomBoard | null, settled: 'done' | 'checked') => void;
}) {
  const session = useSession();
  const can = useCan();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(1);
  const [leaveType, setLeaveType] = useState<LeaveType>('rest');
  const [autoReturn, setAutoReturn] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  useResetOnOpen(!!technician, () => {
    setReason('');
    setDays(1);
    setLeaveType('rest');
    setAutoReturn(true);
  });
  const op = useFrontdeskOp<ClockroomBoard | true>({
    type: 'technician_state',
    visitId: null,
    technicianId: technician?.id ?? null,
    staffName: session.staff.displayName,
    pick: doneOnFound,
  });
  if (!technician) return null;
  // 有待确认的那一笔时，按那一笔原来的动作显示（从顶部提醒、或点了别的按钮打开）
  const pendingAction = (op.pending?.body as { action?: TechStateAction } | undefined)?.action;
  const shown = pendingAction ?? action;
  const t = TEXT[shown];
  const label = `${technician.techNo} 号 ${technician.name}`;
  const trimmed = reason.trim();
  const problem = t.reason === 'required' && trimmed.length < 2 ? '请写原因（至少 2 个字）' : null;

  const longLeave = shown === 'leave' && days > 1;
  const submit = async () => {
    const result = await op.submit((key) =>
      longLeave
        ? {
            url: `/api/clockroom/technicians/${technician.id}/leave-days`,
            body: { clientKey: key, days, leaveType, reason: trimmed || LEAVE_TYPE_LABELS[leaveType], autoReturn },
            tagCodes: [label],
            summary: `休假 ${days} 天（${LEAVE_TYPE_LABELS[leaveType]}${autoReturn ? '，休完自动上牌' : ''}）${trimmed ? `：${trimmed}` : ''}`,
            amount: null,
          }
        : {
            url: `/api/clockroom/technicians/${technician.id}/state`,
            body: { action, ...(t.reason !== 'none' && trimmed ? { reason: trimmed } : {}), clientKey: key },
            tagCodes: [label],
            summary: `${t.title}${t.reason !== 'none' && trimmed ? `：${trimmed}` : ''}`,
            amount: null,
          },
    );
    if (result) onDone(result === true ? null : result, 'done');
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${t.title} · ${label}`}
      description={t.description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {op.pending ? '先关掉' : '取消'}
          </Button>
          <Button variant="primary" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="tech-state-confirm">
            {t.confirm}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={(r) => onDone(r === true ? null : r, 'checked')} />
      {shown === 'leave' && !op.pending && (
        <div className="mb-4 space-y-3">
          <Field label="休几天（从今天起）" hint={hint ?? `最多 ${LEAVE_MAX_DAYS} 天；更长的到「技师管理 → 休假」分开申请`}>
            <QtyInput value={days} min={1} max={LEAVE_MAX_DAYS} onChange={setDays} onHint={setHint} label="休几天" className="w-24" testId="tech-leave-days" />
          </Field>
          {longLeave && (
            <>
              <Field label="休假类型" htmlFor="tech-leave-type">
                <Select id="tech-leave-type" value={leaveType} onChange={(e) => setLeaveType(e.target.value as LeaveType)}>
                  {LEAVE_TYPES.map((k) => (
                    <option key={k} value={k}>
                      {LEAVE_TYPE_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              <ConfirmCheck checked={autoReturn} onChange={setAutoReturn}>
                休完自动上牌（休完后的第一天排到队尾）
              </ConfirmCheck>
              {!can('technician.manage') && <Notice tone="info" title="记成待审批的休假单：技师管理批准以后才算休假，今天照旧上牌" />}
            </>
          )}
        </div>
      )}
      {t.reason !== 'none' && !op.pending && (
        <Field label={t.reason === 'required' ? '原因' : '原因（选填）'} htmlFor="tech-state-reason">
          <Input id="tech-state-reason" value={reason} maxLength={100} placeholder={t.placeholder} onChange={(e) => setReason(e.target.value)} data-autofocus />
        </Field>
      )}
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}
