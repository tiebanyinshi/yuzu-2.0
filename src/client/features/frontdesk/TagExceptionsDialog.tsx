// 8.2.21 异常手牌清单（docs/V82221_TAG_EXCEPTIONS.md；店主 2026-11-27 定「做」）：挂失、未交回的在前（带当时的客人），
// 然后是手动锁定、维修中、暂停使用。↑↓ 选一行、回车 = 找回 / 解锁（值班经理、店总、店主）；「登记未交回」打开锁牌对话框。
// 用得少，按需加载。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LockOpen, Plus } from 'lucide-react';
import { TAG_EXCEPTION_LABELS, type TagException, type TagExceptionKind } from '@shared/frontdesk';
import { api, errorMessage } from '../../lib/api';
import { useListKeys } from '../../lib/keymap';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { Button, Kbd, Notice, Skeleton } from '../../components/ui';
import { ZoneChip } from './parts';

export const tagExceptionsKey = ['frontdesk', 'tag-exceptions'] as const;

const TONE: Record<TagExceptionKind, string> = {
  lost: 'bg-clay text-paper',
  unreturned: 'bg-yuzu-soft text-yuzu-deep',
  locked: 'bg-paper-2 text-ink-2',
  repair: 'bg-paper-2 text-ink-2',
  paused: 'bg-paper-2 text-ink-3',
};

export function TagExceptionsDialog({ open, onClose, onRegister, onDone }: { open: boolean; onClose: () => void; onRegister: () => void; onDone: (message: string) => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: tagExceptionsKey, queryFn: () => api.get<{ tags: TagException[] }>('/api/frontdesk/tag-exceptions'), enabled: open });
  const list = q.data?.tags ?? [];
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlockable = (t: TagException) => t.kind !== 'paused' && t.kind !== 'repair' && can('frontdesk.tags');
  const recover = async (t: TagException) => {
    if (!unlockable(t) || busy !== null) return;
    setBusy(t.tagId);
    setError(null);
    try {
      await api.post(`/api/frontdesk/tags/${t.tagId}/unlock`, {});
      await qc.invalidateQueries({ queryKey: tagExceptionsKey });
      onDone(t.kind === 'locked' ? `手牌 ${t.code} 已解锁` : `手牌 ${t.code} 已找回，可以再发`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const keys = useListKeys(list.length, (i) => void recover(list[i]!));
  const counts = { lost: list.filter((t) => t.kind === 'lost').length, unreturned: list.filter((t) => t.kind === 'unreturned').length };

  return (
    <Dialog
      open={open}
      onClose={busy !== null ? () => {} : onClose}
      title="异常手牌"
      description={`挂失 ${counts.lost} 张 · 未交回 ${counts.unreturned} 张；↑↓ 选、回车找回（解锁）。交班时请一并交接`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={onRegister} data-testid="tag-exceptions-register">
            登记未交回 / 挂失
          </Button>
        </>
      }
    >
      <div tabIndex={0} onKeyDown={keys.onKeyDown} className="outline-none" data-autofocus data-testid="tag-exceptions">
        {q.isLoading ? (
          <Skeleton className="h-24" />
        ) : list.length === 0 ? (
          <p className="py-6 text-center text-[14px] text-ink-3">没有异常手牌</p>
        ) : (
          <ul className="max-h-[55vh] divide-y divide-line overflow-y-auto rounded-[12px] border border-line" role="listbox" aria-label="异常手牌">
            {list.map((t, i) => (
              <li
                key={t.tagId}
                role="option"
                aria-selected={i === keys.active}
                onMouseEnter={() => keys.setActive(i)}
                className={cn('flex items-center gap-2 px-3 py-2', i === keys.active && 'bg-pine-soft/50')}
                data-testid={`tag-exception-${t.code}`}
                data-kind={t.kind}
              >
                <b className="num w-14 text-[15px]">{t.code}</b>
                <ZoneChip zone={t.zone} />
                <span className={cn('rounded-full px-2 py-px text-[12px] font-bold', TONE[t.kind])}>{TAG_EXCEPTION_LABELS[t.kind]}</span>
                <span className="min-w-0 flex-1 text-[13px] text-ink-2">
                  <span className="block truncate">
                    {t.guest ? `${t.guest.name} · ${t.guest.visitNo}${t.guest.checkedOutAt ? ` · ${formatDateTime(t.guest.checkedOutAt)} 结账` : ''}` : (t.reason ?? '')}
                  </span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {t.guest && t.reason ? `${t.reason} · ` : ''}
                    {t.byName ?? ''}
                    {t.at ? ` ${formatDateTime(t.at)}` : ''}
                  </span>
                </span>
                {unlockable(t) && (
                  <Button size="sm" variant="ghost" icon={<LockOpen className="size-4" />} loading={busy === t.tagId} onClick={() => void recover(t)} data-testid={`tag-recover-${t.code}`}>
                    {t.kind === 'locked' ? '解锁' : '找回'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!can('frontdesk.tags') && list.length > 0 && <Notice tone="info" title="找回、解锁需要值班经理、店总或店主" className="mt-3" />}
        {error && <Notice tone="error" title={error} className="mt-3" />}
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-ink-3">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> 选 · <Kbd>Enter</Kbd> 找回 · 维修中、暂停使用的在「手牌管理」里改
        </p>
      </div>
    </Dialog>
  );
}
