// 福田店整改 FT-08（2026-11-26）：在房间卡片上点右键直接设置房态——空闲（清洁完成 / 恢复）、待清、维修。
// 选了马上生效：走房间动作原来的接口（带操作编号、房态版本号、结果待确认），每一次照旧记房间事件与审计（就是「操作记录」）；
// 维修要原因与预计完成时间，选了打开原来的维修对话框。在用的房间不能改房态（先退房）；客房的房态在客房自己的对话框里改。

import { useEffect, useRef } from 'react';
import { CircleCheck, Sparkles, Wrench } from 'lucide-react';
import { ROOM_STATUS_LABELS, type RoomCard } from '@shared/room-center';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { useRoomAction } from './queries';

export interface MenuAt {
  room: RoomCard;
  x: number;
  y: number;
}

/** 右键菜单里能选的目标房态（按这间房现在的状态给）；空的说明为什么不能改 */
export function stateTargets(room: RoomCard): { key: 'cleaned' | 'restore' | 'dirty' | 'maintenance'; label: string }[] {
  if (room.kind === 'hotel' || room.status === 'in_use') return [];
  const out: { key: 'cleaned' | 'restore' | 'dirty' | 'maintenance'; label: string }[] = [];
  if (room.status === 'dirty') out.push({ key: 'cleaned', label: '空闲（清洁完成）' });
  if (room.status === 'maintenance') out.push({ key: 'restore', label: '恢复使用（结束维修）' });
  if (room.status === 'free' || room.status === 'booked') out.push({ key: 'dirty', label: '待清' });
  out.push({ key: 'maintenance', label: room.status === 'maintenance' ? '改维修信息' : '维修…' });
  return out;
}

export function RoomStateMenu({ at, onClose, onMaintenance }: { at: MenuAt; onClose: () => void; onMaintenance: (room: RoomCard) => void }) {
  const can = useCan();
  const toast = useToast();
  const room = at.room;
  const act = useRoomAction(room, 'space_state');
  const ref = useRef<HTMLDivElement>(null);
  const targets = stateTargets(room);
  const allowed = can('room.housekeep');

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', onClose, true);
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const pickTarget = async (key: (typeof targets)[number]['key']) => {
    if (key === 'maintenance') {
      onClose();
      onMaintenance(room);
      return;
    }
    const body = key === 'cleaned' ? { expectedVersion: room.version } : { expectedVersion: room.version, note: '右键设置房态' };
    const summary = `${key === 'cleaned' ? '清洁完成' : key === 'restore' ? '恢复' : '标为待清'} ${room.code}（右键）`;
    const ok = await act.run(key, body, summary);
    onClose();
    if (ok) toast({ tone: 'success', title: `${room.code} 已改为${key === 'dirty' ? '待清' : '空闲'}` });
  };

  // 菜单别伸出屏幕
  const left = Math.min(at.x, window.innerWidth - 232);
  const top = Math.min(at.y, window.innerHeight - 220);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`设置 ${room.code} 的房态`}
      className="fixed z-50 w-56 rounded-lg border border-line bg-card p-1.5 shadow-pop"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      data-testid="rc-state-menu"
    >
      <p className="px-2.5 pt-1 pb-1.5 text-[12px] font-semibold text-ink-3">
        {room.code} · 现在{ROOM_STATUS_LABELS[room.status]} · 设置房态
      </p>
      {targets.length === 0 ? (
        <p className="px-2.5 pb-2 text-[12.5px] text-ink-3" data-testid="rc-state-menu-none">
          {room.kind === 'hotel' ? '客房的房态请点卡片在客房对话框里改' : '有客人在用，先退房（或下钟、结束使用）'}
        </p>
      ) : (
        targets.map((t) => (
          <button
            key={t.key}
            type="button"
            role="menuitem"
            disabled={!allowed || act.locked || act.busy}
            onClick={() => void pickTarget(t.key)}
            className={cn('flex h-11 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13.5px] font-semibold text-ink-2 hover:bg-paper-2 disabled:opacity-50')}
            data-testid={`rc-state-${t.key}`}
          >
            {t.key === 'maintenance' ? <Wrench className="size-4" /> : t.key === 'dirty' ? <Sparkles className="size-4" /> : <CircleCheck className="size-4" />}
            {t.label}
          </button>
        ))
      )}
      {!allowed && targets.length > 0 && <p className="px-2.5 pt-1 pb-1.5 text-[12px] text-ink-3">改房态要「客房打扫、维修」权限</p>}
      {act.locked && <p className="px-2.5 pt-1 pb-1.5 text-[12px] text-clay">这间房上一笔改房态还没确认结果，请点卡片打开详情处理</p>}
    </div>
  );
}
