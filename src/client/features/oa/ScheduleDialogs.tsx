// 排班共用的对话框与辅助函数：PC 周表（ScheduleTab）与手机排班管理（MobileScheduleManagePage）共用，避免双端各写一套。

import { useState } from 'react';
import { describeDate, shiftDate } from '@shared/labels';
import { SCHEDULE_MAX_SHIFTS_PER_DAY, SCHEDULE_SAVE_MAX_CELLS, type OaShift, type ScheduleSaved } from '@shared/oa';
import { shiftTimeText } from '@shared/technician-admin';
import { sendErpOp } from '../../lib/erpPending';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { Button, ConfirmCheck } from '../../components/ui';

export type ScheduleDraftCell = { shiftIds: number[]; consecutive: boolean };
export type ScheduleDraftEdit = { cell: ScheduleDraftCell; expected: ScheduleDraftCell };
export const EMPTY_CELL: ScheduleDraftCell = { shiftIds: [], consecutive: false };
export const scheduleCellKey = (staffId: number, date: string) => `${staffId}|${date}`;
export const sameScheduleCell = (a: ScheduleDraftCell, b: ScheduleDraftCell) =>
  a.consecutive === b.consecutive && a.shiftIds.length === b.shiftIds.length && [...a.shiftIds].sort().join() === [...b.shiftIds].sort().join();

/** 按员工分批提交排班草稿（同一员工一周的格子在同一批里，支持 PC 与手机共用） */
export async function submitScheduleDraft(params: {
  dirty: readonly [string, ScheduleDraftEdit][];
  storeId: number;
  groupId: number;
  groupName: string;
  from: string;
  staffId: number;
  staffName: string;
}): Promise<{ changed: number; done: number }> {
  type SaveCell = ScheduleDraftCell & { staffId: number; date: string; expected: ScheduleDraftCell };
  const byStaff = new Map<number, SaveCell[]>();
  for (const [k, v] of params.dirty) {
    const [sid, date] = k.split('|') as [string, string];
    const id = Number(sid);
    byStaff.set(id, [...(byStaff.get(id) ?? []), { staffId: id, date, shiftIds: v.cell.shiftIds, consecutive: v.cell.consecutive, expected: v.expected }]);
  }
  const batches: SaveCell[][] = [];
  for (const cells of byStaff.values()) {
    const last = batches[batches.length - 1];
    if (last && last.length + cells.length <= SCHEDULE_SAVE_MAX_CELLS) last.push(...cells);
    else batches.push([...cells]);
  }
  let changed = 0;
  let done = 0;
  for (const cells of batches) {
    const key = uuid();
    const r = await sendErpOp<ScheduleSaved>({
      key,
      type: 'oa_schedule_save',
      url: '/api/oa/attendance/schedule',
      body: { clientKey: key, storeId: params.storeId, groupId: params.groupId, cells },
      summary: `${params.groupName} · ${cells.length} 格（${params.from} 那一周）`,
      staffName: params.staffName,
      staffId: params.staffId,
    });
    changed += r.changed;
    done += 1;
  }
  return { changed, done };
}

/** 这一天所在那一周的周一 */
export function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return shiftDate(date, -((weekday + 6) % 7));
}

export const scheduleWeekUrl = (groupId: number | null, from: string | null) => `/api/oa/attendance/schedule?days=7${groupId ? `&groupId=${groupId}` : ''}${from ? `&from=${from}` : ''}`;

export function ScheduleCellDialog({
  target,
  cell,
  shifts,
  name,
  onClose,
  onDone,
}: {
  target: { staffId: number; date: string } | null;
  cell: ScheduleDraftCell;
  shifts: OaShift[];
  name: string;
  onClose: () => void;
  onDone: (cell: ScheduleDraftCell) => void;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [consecutive, setConsecutive] = useState(false);
  useResetOnOpen(
    !!target,
    () => {
      setPicked(cell.shiftIds);
      setConsecutive(cell.consecutive);
    },
    [target],
  );
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= SCHEDULE_MAX_SHIFTS_PER_DAY ? p : [...p, id]));
  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={target ? `${name} · ${target.date}（${describeDate(target.date).weekday}）` : ''}
      description="选一个或几个班次；都不选就是休息。一天几个班、或前一天的跨天班接着第二天的班，打卡时间段挨在一起的要勾「连班」。"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" onClick={() => onDone({ shiftIds: picked, consecutive: picked.length ? consecutive : false })} data-testid="att-cell-done">
            好
          </Button>
        </>
      }
    >
      {shifts.length === 0 ? (
        <p className="text-[13px] text-ink-3">还没有启用中的班次，先到「班次」页签建。</p>
      ) : (
        <div className="space-y-2">
          {shifts.map((s) => (
            <ConfirmCheck key={s.id} checked={picked.includes(s.id)} onChange={() => toggle(s.id)}>
              <span data-testid={`att-cell-shift-${s.name}`}>
                {s.name}
                <span className="num ml-2 text-[13px] font-normal text-ink-3">{shiftTimeText(s)}</span>
                {!s.active && <span className="ml-2 text-[12px] text-clay">（已停用）</span>}
              </span>
            </ConfirmCheck>
          ))}
          {picked.length > 0 && (
            <ConfirmCheck checked={consecutive} onChange={setConsecutive} tone="clay">
              连班：与前后相邻的班次首尾相接，打卡按时间先后分别算
            </ConfirmCheck>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function SchedulePublishDialog({
  open,
  groupName,
  from,
  to,
  unpublishedCount,
  loading,
  onClose,
  onConfirm,
}: {
  open: boolean;
  groupName: string;
  from: string;
  to: string;
  unpublishedCount: number;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={loading ? () => {} : onClose}
      title={`发布排班 · ${groupName}`}
      description="排班发布后才会对员工生效（打卡、每日结算、「我的排班」均以已发布为准），并仅向排班有变动的员工发送站内通知。"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={loading} onClick={onConfirm} data-testid="att-publish-confirm">
            确认发布
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-[14px] text-ink-2" data-testid="att-publish-dialog">
        <p>
          发布范围：<span className="num font-semibold text-ink">{from}</span> 至 <span className="num font-semibold text-ink">{to}</span>
        </p>
        <p>
          待发布改动：<span className="num font-bold text-pine">{unpublishedCount}</span> 格（仅发布今天及以后的排班）
        </p>
      </div>
    </Dialog>
  );
}
