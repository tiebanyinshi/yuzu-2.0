// 前台备注（8.1.44《前台系统开发》第 1、8 条，docs/V8144_CASHIER.md）：收银台单独的「备注」板块，发卡台客人卡上也是这一块。
// 每条写明经办人与时间；有同行时分「同组备注」（整组都看得到）与「单人备注」（只这张手牌）；可带一个标签（客诉、特殊关照……，
// 清单在后台「数据字典与字段」的「前台备注的标签」，待业务确认）。写错了撤下（留原因，划掉显示），不删除。
import { useState } from 'react';
import { MessageSquareText, Undo2 } from 'lucide-react';
import { REMARK_SCOPE_LABELS, MAX_REMARK_LENGTH, type RemarkScope, type VisitRemark } from '@shared/frontdesk-remarks';
import type { VisitDetail } from '@shared/frontdesk';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useReasons, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Button, Notice, Segmented, Textarea } from '../../components/ui';

export function RemarksBoard({ visit, onChanged }: { visit: VisitDetail; onChanged: (v: VisitDetail) => void }) {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const tags = useReasons('remarkTags');
  const removeReasons = useReasons('remarkRemoveReasons');
  const hasGroup = !!visit.group;
  const [scope, setScope] = useState<RemarkScope>('single');
  const [tag, setTag] = useState('');
  const [note, setNote] = useState('');
  /** 操作编号：没收到结果时原样再点一次用同一个编号（服务端只记一条），保存成功后换新的 */
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<VisitRemark | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const writable = visit.status !== 'cancelled' && (can('frontdesk.operate') || can('frontdesk.checkout'));
  const effectiveScope: RemarkScope = hasGroup ? scope : 'single';
  const active = visit.remarks.filter((r) => !r.removed);
  const removed = visit.remarks.filter((r) => r.removed);

  const submit = async () => {
    if (!note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api.post<VisitDetail>(`/api/frontdesk/visits/${visit.id}/remarks`, { clientKey: key, scope: effectiveScope, ...(tag ? { tag } : {}), note: note.trim() });
      setNote('');
      setTag('');
      setKey(uuid());
      onChanged(v);
      toast({ tone: 'success', title: `已记${REMARK_SCOPE_LABELS[effectiveScope]}` });
    } catch (e) {
      // 没收到结果：内容先别改，再点一次「记下」用同一个编号，不会记两条
      setError(e instanceof UncertainError ? '没收到保存结果，请不要改内容，直接再点一次「记下」（不会记两条）' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-3 rounded-[14px] border border-line bg-card px-4 py-3 shadow-card" aria-label="前台备注" data-testid="remarks-board">
      <h3 className="flex items-center gap-1.5 text-[13px] font-bold text-ink-2">
        <MessageSquareText className="size-4 text-pine" /> 备注（客诉 / 特殊标签）
        <span className="ml-auto text-[12px] font-semibold text-ink-3">{active.length ? `${active.length} 条` : '没有备注'}</span>
      </h3>
      {active.length > 0 && (
        <ul className="mt-2 space-y-2" data-testid="remarks-list">
          {active.map((r) => (
            <RemarkRow key={r.id} remark={r} canRemove={writable && (r.createdById === session.staff.id || can('frontdesk.correct'))} onRemove={() => setRemoving(r)} />
          ))}
        </ul>
      )}
      {removed.length > 0 && (
        <details className="mt-2 text-[12px] text-ink-3">
          <summary className="cursor-pointer font-semibold">已撤下 {removed.length} 条（留痕）</summary>
          <ul className="mt-1.5 space-y-1.5">
            {removed.map((r) => (
              <RemarkRow key={r.id} remark={r} canRemove={false} onRemove={() => {}} />
            ))}
          </ul>
        </details>
      )}
      {writable && (
        <div className="mt-3 border-t border-dashed border-line pt-3" data-testid="remark-form">
          <div className="flex flex-wrap items-center gap-2">
            {hasGroup && (
              <Segmented
                size="sm"
                value={scope}
                onChange={(s) => {
                  setScope(s);
                  setError(null);
                  setKey(uuid());
                }}
                ariaLabel="备注范围"
                options={[
                  { value: 'single', label: `单人 · ${visit.tag.code}` },
                  { value: 'group', label: `同组 · ${visit.group!.groupNo}` },
                ]}
              />
            )}
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="备注标签" data-testid="remark-tags">
              {tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={tag === t}
                  onClick={() => {
                    setTag((x) => (x === t ? '' : t));
                    setError(null);
                    setKey(uuid());
                  }}
                  className={cn(
                    'tap relative h-8 rounded-full border px-3 text-[12.5px] font-semibold',
                    tag === t ? 'border-clay bg-clay-soft text-clay' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <Textarea
            className="mt-2 min-h-[44px]"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setError(null);
              setKey(uuid());
            }}
            maxLength={MAX_REMARK_LENGTH}
            placeholder={effectiveScope === 'group' ? '整组的说明（同组每张手牌都看得到）' : `只说 ${visit.tag.code} 这位客人`}
            aria-label="备注内容"
            data-testid="remark-note"
          />
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[12px] text-ink-3">记下经办人 {session.staff.displayName} 与时间</span>
            <Button size="sm" variant="secondary" className="ml-auto" disabled={!note.trim()} loading={busy} onClick={submit} data-testid="remark-submit">
              记下
            </Button>
          </div>
          {error && <Notice tone="error" title={error} className="mt-2" />}
        </div>
      )}
      <ReasonDialog
        open={!!removing}
        title={removing ? `撤下备注「${removing.note.slice(0, 20)}」` : ''}
        description="撤下的备注照旧留着（划掉显示），记下撤下的人、时间与原因"
        confirmLabel="撤下"
        danger
        busy={removeBusy}
        reasons={removeReasons}
        testId="remark-remove"
        onClose={() => setRemoving(null)}
        onConfirm={async (reason) => {
          if (!removing) return;
          setRemoveBusy(true);
          try {
            onChanged(await api.post<VisitDetail>(`/api/frontdesk/remarks/${removing.id}/remove`, { visitId: visit.id, reason }));
            setRemoving(null);
            toast({ tone: 'success', title: '已撤下这条备注' });
          } catch (e) {
            toast({ tone: 'error', title: '撤下未成功', body: errorMessage(e) });
          } finally {
            setRemoveBusy(false);
          }
        }}
      />
    </section>
  );
}

function RemarkRow({ remark: r, canRemove, onRemove }: { remark: VisitRemark; canRemove: boolean; onRemove: () => void }) {
  return (
    <li className="text-[13px]" data-testid={`remark-${r.id}`}>
      <div className="flex items-start gap-2">
        <p className={cn('min-w-0 flex-1', r.removed && 'text-ink-3 line-through')}>
          <span className={cn('mr-1 rounded-sm px-1 text-[12px] font-bold', r.scope === 'group' ? 'bg-pine-soft text-pine' : 'bg-paper-2 text-ink-2')}>
            {r.scope === 'group' ? `同组 ${r.groupNo ?? ''}` : `单人 ${r.tagCode}`}
          </span>
          {r.tag && <span className="mr-1 rounded-sm bg-clay-soft px-1 text-[12px] font-bold text-clay">{r.tag}</span>}
          <span className="break-words">{r.note}</span>
        </p>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="tap relative flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-semibold text-ink-3 hover:bg-clay-soft hover:text-clay"
            aria-label={`撤下备注 ${r.note}`}
          >
            <Undo2 className="size-3.5" /> 撤下
          </button>
        )}
      </div>
      <p className="num text-[12px] text-ink-4">
        {formatDateTime(r.createdAt)} · {r.createdByName}
        {r.scope === 'group' && ` · 写在 ${r.tagCode}`}
        {r.removed && ` · ${r.removed.byName} ${formatDateTime(r.removed.at)} 撤下：${r.removed.reason}`}
      </p>
    </li>
  );
}
