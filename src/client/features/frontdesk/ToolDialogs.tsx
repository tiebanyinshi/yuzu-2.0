// 前台小工具（v0.5.0）：按姓名、称呼或手机尾号找在店客人。锁牌 / 解锁在 TagLockDialog.tsx（按需加载）。

import { useMemo, useState } from 'react';
import type { BoardTag } from '@shared/frontdesk';
import { formatTime } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Input } from '../../components/ui';
import { ZoneChip } from './parts';

/** 找在店客人：姓名、称呼按包含匹配；纯数字按会员手机尾号匹配 */
export function FindGuestDialog({ open, tags, onClose, onPick }: { open: boolean; tags: BoardTag[]; onClose: () => void; onPick: (visitId: number) => void }) {
  const [q, setQ] = useState('');
  useResetOnOpen(open, () => setQ(''));
  const query = q.trim();
  const results = useMemo(() => {
    if (!query) return [];
    const digits = /^\d{1,4}$/.test(query);
    return tags.filter((t) => {
      const v = t.visit;
      if (!v) return false;
      if (digits) return !!v.memberPhoneTail?.endsWith(query);
      return (v.memberName ?? '').includes(query) || v.guestLabel.includes(query);
    });
  }, [tags, query]);
  const pick = (t: BoardTag) => {
    onPick(t.visit!.id);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="找在店客人" description="按会员姓名、散客称呼或手机尾号（后 4 位）查找；牌号直接在牌号框里敲">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results.length === 1) pick(results[0]!);
        }}
        placeholder="姓名、称呼或手机尾号"
        aria-label="姓名、称呼或手机尾号"
        data-autofocus
        data-testid="find-guest-input"
        autoComplete="off"
      />
      {query && (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line" data-testid="find-guest-results">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-[13px] text-ink-3">没有找到在店的「{query}」</li>
          ) : (
            results.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => pick(t)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-paper-2/60"
                  data-testid={`find-guest-${t.code}`}
                >
                  <span className="num text-[16px] font-bold">{t.code}</span>
                  <ZoneChip zone={t.zone} />
                  <span className="font-semibold">{t.visit!.memberName ?? (t.visit!.guestLabel || '散客')}</span>
                  {t.visit!.memberPhoneTail && <span className="num text-[12.5px] text-ink-3">尾号 {t.visit!.memberPhoneTail}</span>}
                  <span className="flex-1" />
                  <span className="num text-[12.5px] text-ink-3">{formatTime(t.visit!.checkedInAt)} 入场</span>
                  <Money cents={t.visit!.amountCents} className="font-bold" />
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      {results.length > 1 && <p className="mt-2 text-[12.5px] text-ink-3">对上 {results.length} 位，请点选</p>}
    </Dialog>
  );
}
