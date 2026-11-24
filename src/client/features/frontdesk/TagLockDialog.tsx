// 锁牌 / 解锁（前台「锁牌 / 解锁」与点锁定的牌打开）：用得少，按需加载，不进首屏主包（手牌管理 2026-11-24 腾出首屏预算）

import { useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { normalizeTagCode, uniqueTagMatch, ZONE_LABELS, type BoardTag } from '@shared/frontdesk';
import { api, errorMessage } from '../../lib/api';
import { useCan, useReasons } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Input, Notice } from '../../components/ui';
import { ZoneChip } from './parts';

/** 锁牌 / 解锁：空闲手牌丢失、损坏时锁定，找回或修好后解锁（值班经理、店总、店主） */
export function TagLockDialog({ open, tags, initialCode, onClose, onDone }: { open: boolean; tags: BoardTag[]; initialCode?: string; onClose: () => void; onDone: (message: string) => void }) {
  const can = useCan();
  const lockReasons = useReasons('lockReasons');
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setCode(initialCode ?? '');
    setReason('');
    setError(null);
  }, [initialCode]);

  const c = normalizeTagCode(code);
  const tag = c ? (tags.find((t) => t.code === c) ?? uniqueTagMatch(tags, c)) : null;
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone(message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="锁牌 / 解锁"
      description="空闲手牌丢失、损坏或柜锁故障时锁定，锁定的牌不能发出；找回或修好后解锁。在店客人的牌请先换牌并勾选「锁定原手牌」"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          {tag?.locked ? (
            <Button
              variant="primary"
              size="lg"
              icon={<LockOpen className="size-4" />}
              loading={busy}
              disabled={!can('frontdesk.tags')}
              onClick={() => run(() => api.post(`/api/frontdesk/tags/${tag.id}/unlock`, {}), `手牌 ${tag.code} 已解锁`)}
              data-testid="tag-unlock"
            >
              解锁 {tag.code}
            </Button>
          ) : (
            <Button
              variant="danger"
              size="lg"
              icon={<Lock className="size-4" />}
              loading={busy}
              disabled={!tag || !!tag.visit || reason.trim().length < 2}
              onClick={() => tag && run(() => api.post(`/api/frontdesk/tags/${tag.id}/lock`, { reason: reason.trim() }), `手牌 ${tag.code} 已锁定`)}
              data-testid="tag-lock"
            >
              锁定{tag ? ` ${tag.code}` : ''}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <Field label="牌号" htmlFor="tag-lock-code">
          <Input
            id="tag-lock-code"
            value={code}
            onChange={(e) => {
              setCode(normalizeTagCode(e.target.value));
              setError(null);
            }}
            placeholder="如 A023"
            className="num text-[18px] font-bold"
            data-autofocus
            autoComplete="off"
            data-testid="tag-lock-code"
          />
        </Field>
        {c && !tag && <Notice tone="error" title={`没有找到手牌「${c}」，请输入完整牌号`} />}
        {tag && (
          <div className="flex flex-wrap items-center gap-2 text-[13.5px]" data-testid="tag-lock-status">
            <span className="num text-[18px] font-bold">{tag.code}</span>
            <ZoneChip zone={tag.zone} />
            <span className={cn('font-semibold', tag.locked ? 'text-clay' : tag.visit ? 'text-pine' : 'text-ink-2')}>
              {tag.locked ? `已锁定：${tag.lockReason ?? ''}` : tag.visit ? `在店（${tag.visit.memberName ?? (tag.visit.guestLabel || '散客')}）` : `空闲 · ${ZONE_LABELS[tag.zone].title}`}
            </span>
          </div>
        )}
        {tag?.visit && (
          <Notice tone="warning" title="这张牌上有在店客人，不能直接锁定">
            丢失或损坏时，请在手牌账单里给客人换牌并勾选「锁定原手牌」。
          </Notice>
        )}
        {tag && !tag.locked && !tag.visit && (
          <Field label="锁定原因">
            <div className="flex flex-wrap gap-1.5">
              {lockReasons.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={cn(
                    'tap relative h-8 rounded-full border px-3 text-[13px] font-semibold',
                    reason === r ? 'border-clay bg-clay-soft text-clay' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="或填写其他原因" maxLength={100} className="mt-2" aria-label="锁定原因" />
          </Field>
        )}
        {tag?.locked && !can('frontdesk.tags') && <Notice tone="info" title="解锁需要值班经理、店总或店主" />}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
