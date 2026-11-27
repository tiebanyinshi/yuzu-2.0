// 钟房日志（8.2.2 从 clockroom.ts 拆出来：那个文件快到 1500 行）：按营业日列出钟房的每一件事，每条写成一句话。

import { CALL_TYPE_LABELS, type CallType } from '@shared/technicians';
import { EVENT_KIND_LABELS, type ClockEvent, type ClockEventKind } from '@shared/clockroom';
import type { Db } from '../db';
import { currentStoreId } from '../lib/store-context';

const CALL: Record<CallType, string> = CALL_TYPE_LABELS;

function eventText(kind: ClockEventKind, d: Record<string, unknown>): string {
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  switch (kind) {
    case 'dispatch':
      return `${s('tag')} ${s('item')} × ${d.clocks ?? 1}（${CALL[d.callType as CallType] ?? ''}）${s('room') ? `，房间 ${s('room')}` : ''}${d.via === 'frontdesk' ? '，前台挂账' : ''}${d.via === 'assign' ? '，前台已点、钟房补派' : ''}${d.booking ? '，按预约' : ''}${d.backfill ? '，补录纸质单' : ''}`;
    case 'transfer':
      return `${d.to ? `转给 ${s('to')}` : `从 ${s('from')} 转来`}（${s('sessionNo')}）${s('reason') ? `：${s('reason')}` : ''}`;
    case 'sign_in':
      if (d.auto === 'leave_return') return `休假到期（${s('leave')}），自动上牌、排到队尾`;
      return d.from === 'leave' ? `取消休假，上牌${s('reason') ? `：${s('reason')}` : ''}` : s('reason');
    case 'sign_out':
      return d.from === 'leave' ? `取消休假${s('reason') ? `：${s('reason')}` : ''}` : s('reason');
    case 'resume':
      return `复牌${s('suspendedReason') ? `（停牌原因：${s('suspendedReason')}）` : ''}${s('reason') ? `：${s('reason')}` : ''}`;
    case 'room':
      return d.to ? `${d.from ? `房间 ${s('from')} → ` : '选房间 '}${s('to')}` : `清掉房间 ${s('from')}`;
    case 'queue':
      return d.before ? `调到 ${s('before')} 号前面${s('reason') ? `：${s('reason')}` : ''}` : s('reason');
    case 'skip':
      return `轮到时跳过，派给 ${s('to')}${s('reason') ? `：${s('reason')}` : ''}`;
    case 'extend':
      return `加钟 × ${d.clocks ?? 1}（${CALL[d.callType as CallType] ?? ''}）`;
    case 'change':
      return d.to ? `换工种：${s('item')}，转给 ${s('to')}${s('reason') ? `（${s('reason')}）` : ''}` : `换项目：${s('from')} → ${s('item')}${s('reason') ? `（${s('reason')}）` : ''}`;
    case 'finish':
      return `${d.auto ? `自动下钟（${s('auto')}），` : ''}实际 ${d.minutes ?? '?'} 分钟（计划 ${d.planned ?? '?'} 分钟）`;
    default:
      return s('reason');
  }
}

export async function clockEvents(db: Db, date: string): Promise<ClockEvent[]> {
  const rows = await db<
    { id: number; createdAt: string; kind: ClockEventKind; techNo: string | null; techName: string | null; sessionNo: string | null; staffName: string; detail: Record<string, unknown> }[]
  >`
    SELECT e.id, e.created_at, e.kind, t.tech_no, t.name AS tech_name, s.session_no, st.display_name AS staff_name, e.detail
    FROM technician_events e LEFT JOIN technicians t ON t.id = e.technician_id LEFT JOIN technician_sessions s ON s.id = e.session_id
    JOIN staff st ON st.id = e.staff_id
    WHERE e.business_date = ${date} AND coalesce(t.store_id, 1) = ${currentStoreId()} ORDER BY e.id DESC LIMIT 500`;
  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.createdAt).toISOString(),
    kind: r.kind,
    techNo: r.techNo,
    techName: r.techName,
    sessionNo: r.sessionNo,
    staffName: r.staffName,
    text: eventText(r.kind, r.detail ?? {}) || EVENT_KIND_LABELS[r.kind],
  }));
}
