// 一次给多张手牌派钟（8.1.40，docs/V8140_B.md 第 4 节）：几张手牌各选项目、上钟方式、技师，一次提交；
// 服务端一个事务、全部生效或全部不生效，按来访先后（手牌发出的先后）逐条走单张派钟的规则。
// 与单张派钟同一套「结果待确认」（挂账 bill_post；提交前本机保存原编号与原请求，这几张手牌上都不能另起一笔挂账）。
// 这里只派新的一钟（挂账）；前台已经点了、等钟房派技师的（待派钟）照旧在「待派钟」里一条条补派，不另收费。
// 价格档按技师等级或项目的第一档；要选别的价格档、选房间、按预约派，请用单张派钟。

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { tierPrice, type PriceTier } from '@shared/catalog';
import type { BoardTechnician, ClockroomBoard } from '@shared/clockroom';
import type { FrontdeskBoard } from '@shared/frontdesk';
import { CALL_TYPE_LABELS, canServe, tierFor, type CallType } from '@shared/technicians';
import { api } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Input, Notice, Segmented, Select } from '../../components/ui';
import { PendingPanel, useFrontdeskOp, useFrontdeskPending } from '../frontdesk/pending';

export const BATCH_DISPATCH_URL = '/api/clockroom/dispatch-batch';
const MAX_ROWS = 10;

interface Row {
  rid: number;
  tagText: string;
  itemId: number | null;
  callType: CallType;
  /** 店员点选的技师；轮钟没点选时按排位自动选 */
  technicianId: number | null;
  skipReason: string;
}

let ridSeq = 0;
const blank = (callType: CallType, tagText = ''): Row => ({ rid: ++ridSeq, tagText, itemId: null, callType, technicianId: null, skipReason: '' });
const dispatchable = (t: BoardTechnician) => t.active && !t.suspendedAt && (t.state === 'on' || t.state === 'rest');
const doneOnFound = (found: { found: true } | { found: false }) => (found.found && 'visit' in found ? true : null);

export function BatchDispatchDialog({ open, board, onClose, onDone }: { open: boolean; board: ClockroomBoard; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const catalog = useCatalog();
  const tags = useQuery({ queryKey: ['frontdesk', 'board'], queryFn: () => api.get<FrontdeskBoard>('/api/frontdesk/board'), enabled: open });
  const [rows, setRows] = useState<Row[]>([]);
  const [startNow, setStartNow] = useState(true);
  useResetOnOpen(open, () => {
    setRows([blank(board.techRules.defaultCallType), blank(board.techRules.defaultCallType)]);
    setStartNow(true);
  });
  const patch = (rid: number, p: Partial<Row>) => setRows((list) => list.map((r) => (r.rid === rid ? { ...r, ...p } : r)));

  const inStore = useMemo(() => (tags.data?.tags ?? []).filter((t) => t.visit), [tags.data]);
  const busyVisits = new Set(board.sessions.map((s) => s.visitId));
  const tagOf = (text: string) => inStore.find((t) => t.code.toLowerCase() === text.trim().toLowerCase()) ?? null;
  const allItems = catalog.data?.items ?? [];

  // 按来访先后（服务端派的顺序）逐行算：轮钟默认给排位最前、还空着的；前面几行派出去的技师算在钟上
  const plan = useMemo(() => {
    const ordered = rows.map((r, i) => ({ r, i, tag: tagOf(r.tagText) })).sort((a, b) => (a.tag?.visit?.id ?? Number.MAX_SAFE_INTEGER) - (b.tag?.visit?.id ?? Number.MAX_SAFE_INTEGER) || a.i - b.i);
    const taken = new Set<number>();
    const out = new Map<number, { tech: BoardTechnician | null; options: BoardTechnician[]; skipping: BoardTechnician | null; price: number | null; tier: PriceTier | null }>();
    for (const { r, tag } of ordered) {
      const item = allItems.find((i) => i.id === r.itemId) ?? null;
      const shape = item ? { category: item.category, prices: item.prices } : null;
      const free = (t: BoardTechnician) => t.state === 'on' && !t.busy && !taken.has(t.id) && !t.booking?.locked && !t.suspendedAt && !!shape && !canServe(t, shape, board.techRules.tierByGrade);
      const options =
        r.callType === 'rotation'
          ? board.technicians.filter(free).sort((a, b) => a.position! - b.position!)
          : board.technicians.filter(dispatchable).sort((a, b) => Number(a.techNo) - Number(b.techNo) || a.techNo.localeCompare(b.techNo));
      const tech = board.technicians.find((t) => t.id === r.technicianId) ?? (r.callType === 'rotation' ? (options[0] ?? null) : null);
      // 轮钟跳过：同工种里排在他前面、还空着的
      const skipping = r.callType === 'rotation' && tech ? (options.find((t) => t.kind.trim() === tech.kind.trim() && t.position! < tech.position!) ?? null) : null;
      const tier = item && tech ? tierFor(tech, item, item.prices[0]!.tier, board.techRules.tierByGrade) : null;
      const price = item && tier ? tierPrice(item.prices, tier) : null;
      if (tech && tag?.visit) taken.add(tech.id);
      out.set(r.rid, { tech, options, skipping, price, tier });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, board, allItems, inStore]);

  const problems = rows.map((r) => {
    const tag = tagOf(r.tagText);
    const p = plan.get(r.rid);
    const item = allItems.find((i) => i.id === r.itemId) ?? null;
    if (!tag?.visit) return '输入在店客人的手牌号';
    if (!item) return '选项目';
    if (item.gender && item.gender !== tag.zone) return `「${item.name}」不适合这位客人`;
    if (!p?.tech) return '选技师';
    const why = canServe(p.tech, item, board.techRules.tierByGrade);
    if (why) return `${p.tech.techNo} 号${why}`;
    if (p.price === null) return '这个项目没有这一档价格';
    if (p.skipping && board.rules.skipNeedsReason && r.skipReason.trim().length < 2) return `轮钟应派给 ${p.skipping.techNo} 号；要改派请写原因`;
    return null;
  });
  const visitIds = rows.map((r) => tagOf(r.tagText)?.visit?.id).filter((x): x is number => x !== undefined);
  const dupTech = (() => {
    const seen = new Set<number>();
    for (const r of rows) {
      const t = plan.get(r.rid)?.tech;
      if (t && r.callType === 'rotation' && seen.has(t.id)) return `${t.techNo} 号在这一批里派了两次轮钟`;
      if (t) seen.add(t.id);
    }
    return null;
  })();
  const total = rows.reduce((n, r) => n + (plan.get(r.rid)?.price ?? 0), 0);

  // 有一笔「一次派钟」结果待确认：按它记下的那位客人认出来（关掉再开也看得到）
  const allPending = useFrontdeskPending();
  const stale = allPending.find((p) => p.url === BATCH_DISPATCH_URL) ?? null;
  // 这一批里任何一位客人还有别的结果待确认（单张派钟、挂账、结账……）：先处理好那一笔再派，
  // 不然两笔用不同的编号都生效，同一位客人会重复挂账（合并前 Codex 审查 8a7023d：以前只看编号最小的那位）
  const blocker = allPending.find((p) => p.key !== stale?.key && visitIds.some((v) => p.visitId === v || !!p.visitIds?.includes(v))) ?? null;
  const blockerText = blocker
    ? `手牌 ${blocker.tagCodes.filter((c) => rows.some((r) => r.tagText.trim().toLowerCase() === c.toLowerCase())).join('、') || blocker.tagCodes.join('、')} 还有一笔「${blocker.summary}」结果待确认，请先在前台顶上的「结果待确认」里处理好再派`
    : null;
  // 在店手牌、价目还没取到或取不到：先说这个，不把每张手牌都说成「不是在店客人的手牌」（合并前 Codex 审查 1c79c00）
  const tagsFailed = tags.isError && !tags.data;
  const catalogFailed = catalog.isError && !catalog.data;
  const loadProblem = tagsFailed || catalogFailed ? '在店手牌或价目没取到，请重试' : tags.isPending || catalog.isPending ? '正在取在店手牌与价目…' : null;
  const firstProblem = loadProblem ?? (rows.length === 0 ? '请至少加一张手牌' : (problems.map((p, i) => (p ? `第 ${i + 1} 行：${p}` : null)).find(Boolean) ?? dupTech ?? blockerText));
  const anchor = stale?.visitId ?? (visitIds.length ? Math.min(...visitIds) : null);
  const op = useFrontdeskOp<true>({ type: 'bill_post', visitId: anchor, staffName: session.staff.displayName, pick: doneOnFound });

  const submit = async () => {
    if (firstProblem) return;
    const lines = rows.map((r) => ({ r, tag: tagOf(r.tagText)!, p: plan.get(r.rid)!, item: allItems.find((i) => i.id === r.itemId)! }));
    const ok = await op.submit((key) => ({
      url: BATCH_DISPATCH_URL,
      body: {
        clientKey: key,
        entries: lines.map(({ r, tag, p, item }) => ({
          visitId: tag.visit!.id,
          itemId: item.id,
          tier: board.techRules.tierByGrade && item.prices.length > 1 ? undefined : (p.tier ?? undefined),
          quantity: 1,
          technicianId: p.tech!.id,
          callType: r.callType,
          startNow: startNow && !p.tech!.busy,
          skipReason: p.skipping ? r.skipReason.trim() || undefined : undefined,
          expectedTotal: p.price!,
        })),
      },
      tagCodes: lines.map((l) => l.tag.code),
      visitIds: [...new Set(lines.map((l) => l.tag.visit!.id))],
      summary: `一次派钟 ${lines.length} 张手牌：${lines.map((l) => `${l.tag.code} ${l.item.name}（${l.p.tech!.techNo} 号 · ${CALL_TYPE_LABELS[l.r.callType]}）`).join('、')}`,
      amount: total,
    }));
    if (ok) onDone();
  };

  // 还没派钟的在店手牌：点一下加一行
  const shown = new Set(rows.map((r) => r.tagText.trim().toLowerCase()));
  const waiting = inStore.filter((t) => !busyVisits.has(t.visit!.id) && !shown.has(t.code.toLowerCase())).slice(0, 30);
  const addTag = (code: string) =>
    setRows((list) => {
      const empty = list.find((r) => !r.tagText.trim());
      if (empty) return list.map((r) => (r.rid === empty.rid ? { ...r, tagText: code } : r));
      return list.length >= MAX_ROWS ? list : [...list, blank(board.techRules.defaultCallType, code)];
    });
  const items = (zone: string | undefined) => allItems.filter((i) => i.active && i.technicianRequired && (!i.gender || !zone || i.gender === zone));

  return (
    <Dialog
      open={open}
      onClose={op.busy ? () => {} : onClose}
      width="max-w-4xl"
      title="一次派钟"
      description="几张手牌一次派完：每行一张手牌、一个项目、一位技师（各 1 钟）。一起提交，有一行不行就都不派；轮钟按手牌发出的先后排。价格档、房间、按预约派请用单张派钟。"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            {firstProblem ? (
              <span className="text-clay">{firstProblem}</span>
            ) : (
              <>
                {rows.length} 张手牌，合计 <Money cents={total} className="text-[17px] font-bold text-ink" />
              </>
            )}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!!firstProblem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="batch-dispatch-submit">
            一次派 {rows.length} 张
          </Button>
        </>
      }
    >
      {(tagsFailed || catalogFailed) && (
        <LoadFailed
          title={tagsFailed ? '在店手牌没取到' : '价目没取到'}
          onRetry={() => void (tagsFailed ? tags.refetch() : catalog.refetch())}
          retrying={tags.isFetching || catalog.isFetching}
          className="mb-3"
          testId="batch-dispatch-failed"
        />
      )}
      <PendingPanel op={op} onResolved={() => onDone()} />
      {waiting.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-[12.5px] font-semibold text-ink-3">还没派钟的在店手牌（点一下加进来）</p>
          <div className="flex flex-wrap gap-1.5" data-testid="batch-dispatch-tags">
            {waiting.map((t) => (
              <button
                key={t.code}
                type="button"
                disabled={rows.length >= MAX_ROWS && rows.every((r) => r.tagText.trim())}
                onClick={() => addTag(t.code)}
                className="tap relative h-8 rounded-full border border-line-strong px-3 text-[12.5px] font-semibold text-ink-2 hover:border-ink-4 disabled:opacity-50"
              >
                <span className="num">{t.code}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-2" data-testid="batch-dispatch-rows">
        {rows.map((r, i) => {
          const tag = tagOf(r.tagText);
          const p = plan.get(r.rid);
          const problem = problems[i];
          return (
            <div key={r.rid} className={cn('rounded-lg border p-2.5', problem && r.tagText.trim() ? 'border-clay/50' : 'border-line')} data-testid={`batch-row-${i}`}>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-[110px_minmax(0,1fr)_150px_minmax(0,1fr)_auto]">
                <Input
                  value={r.tagText}
                  onChange={(e) => patch(r.rid, { tagText: e.target.value })}
                  className="num"
                  placeholder="手牌号"
                  aria-label={`第 ${i + 1} 行手牌`}
                  data-testid={`batch-tag-${i}`}
                />
                <Select
                  className="min-w-0"
                  value={r.itemId ?? ''}
                  onChange={(e) => patch(r.rid, { itemId: e.target.value ? Number(e.target.value) : null, technicianId: null })}
                  aria-label={`第 ${i + 1} 行项目`}
                  data-testid={`batch-item-${i}`}
                >
                  <option value="">选项目</option>
                  {items(tag?.zone).map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name}
                    </option>
                  ))}
                </Select>
                <Segmented
                  size="sm"
                  ariaLabel={`第 ${i + 1} 行上钟方式`}
                  value={r.callType}
                  onChange={(v) => patch(r.rid, { callType: v, technicianId: null })}
                  options={[
                    { value: 'rotation', label: CALL_TYPE_LABELS.rotation },
                    { value: 'designated', label: CALL_TYPE_LABELS.designated },
                  ]}
                />
                <Select
                  className="min-w-0"
                  value={p?.tech?.id ?? ''}
                  onChange={(e) => patch(r.rid, { technicianId: e.target.value ? Number(e.target.value) : null })}
                  disabled={!r.itemId}
                  aria-label={`第 ${i + 1} 行技师`}
                  data-testid={`batch-tech-${i}`}
                >
                  <option value="">{r.itemId ? (p?.options.length ? '选技师' : '没有能派的技师') : '先选项目'}</option>
                  {p?.options.map((t) => (
                    <option key={t.id} value={t.id}>
                      {r.callType === 'rotation' ? `第 ${t.position} 位 · ` : ''}
                      {t.techNo} 号 {t.name}
                      {t.busy ? '（在钟上，要等钟）' : t.state === 'rest' ? '（暂离）' : ''}
                    </option>
                  ))}
                  {p?.tech && !p.options.some((t) => t.id === p.tech!.id) && (
                    <option value={p.tech.id}>
                      {p.tech.techNo} 号 {p.tech.name}（这一批里已经派了）
                    </option>
                  )}
                </Select>
                <button
                  type="button"
                  className="tap relative col-span-2 inline-flex h-11 items-center justify-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold text-ink-3 hover:bg-paper-2 md:col-span-1"
                  onClick={() => setRows((list) => list.filter((x) => x.rid !== r.rid))}
                  disabled={op.busy}
                  aria-label={`删掉第 ${i + 1} 行`}
                >
                  <Trash2 className="size-4" /> 删掉
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                <span className="text-ink-3">
                  {tag?.visit ? `${tag.zone === 'female' ? '女宾' : '男宾'} · ${tag.visit.memberName ?? (tag.visit.guestLabel || '散客')}` : r.tagText.trim() ? '不是在店客人的手牌' : ''}
                </span>
                {p?.price != null && <Money cents={p.price} className="font-bold text-ink-2" />}
                {tag?.visit && r.itemId && board.pending.some((x) => x.visitId === tag.visit!.id && x.itemId === r.itemId) && (
                  <span className="font-semibold text-yuzu-deep">前台已点了这一项、还没派技师：请到「待派钟」补派，这里再派会另收一次</span>
                )}
                {problem && r.tagText.trim() && <span className="font-semibold text-clay">{problem}</span>}
              </div>
              {p?.skipping && (
                <Input
                  className="mt-1.5"
                  value={r.skipReason}
                  maxLength={100}
                  onChange={(e) => patch(r.rid, { skipReason: e.target.value })}
                  placeholder={`改派原因（轮钟应派给 ${p.skipping.techNo} 号 ${p.skipping.name}）`}
                  aria-label={`第 ${i + 1} 行改派原因`}
                  data-testid={`batch-skip-${i}`}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus className="size-4" />}
          disabled={rows.length >= MAX_ROWS || op.busy}
          onClick={() => setRows((list) => [...list, blank(board.techRules.defaultCallType)])}
          data-testid="batch-add-row"
        >
          加一张手牌{rows.length >= MAX_ROWS ? `（最多 ${MAX_ROWS} 张）` : ''}
        </Button>
        <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
          <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
          技师到了，立即上钟
        </label>
      </div>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}
