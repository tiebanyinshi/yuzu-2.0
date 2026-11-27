// 8.2.10 休闲娱乐（docs/V82210_LEISURE.md）：网吧、桌球等按台位计时，各自单独收费（各自的收银项目，部门「娱乐」）。
//   · 刷手牌：这张牌有在用的台位 → 直接弹「结束计时」；没有 → 点一台空闲的开始计时（牌号带进开单）；
//   · 台位卡片：空闲 / 使用中（手牌、已用多久、按现在结束约多少钱），点使用中的结束；
//   · 店主（后台设置权限）：「按价目表一键建」——生效中的价目表「娱乐价格」里按时长收费的几行建业态、计费、台位。
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gamepad2, Wand2 } from 'lucide-react';
import { leisureCode, type LeisurePlan, type LeisureSetupResult } from '@shared/leisure';
import { formatYuan } from '@shared/money';
import { durationText, pricingText, usageEstimate, usageMinutes, type UsageBoard, type UsageBoardSpace, type UsageDetail } from '@shared/usages';
import { api, errorMessage } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useSession } from '../../lib/session';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, Notice, Segmented, Select } from '../../components/ui';
import { TagCardInput } from '../frontdesk/TagCardInput';
import { CloseUsageFor, OpenUsageDialog } from '../rooms/UsageDialogs';

export function LeisurePage() {
  const session = useSession();
  const qc = useQueryClient();
  const [board, setBoard] = useState<UsageBoard | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [type, setType] = useState<string>('');
  const [tag, setTag] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [opening, setOpening] = useState<UsageBoardSpace | null>(null);
  const [ending, setEnding] = useState<UsageDetail | null>(null);
  const [setup, setSetup] = useState(false);

  useLivePoll(
    async (isLive) => {
      try {
        const b = await api.get<UsageBoard>('/api/usages/board');
        if (isLive()) {
          setBoard(b);
          setFailed(null);
          setTick((t) => t + 1);
        }
      } catch (e) {
        if (isLive()) setFailed(errorMessage(e));
      }
    },
    [],
    { intervalMs: 5000 },
  );
  const refresh = async () => {
    setBoard(await api.get<UsageBoard>('/api/usages/board'));
    void qc.invalidateQueries({ queryKey: ['rooms'] });
  };

  const types = useMemo(() => {
    if (!board) return [];
    const list = board.leisureTypes?.length ? board.leisureTypes : board.businessTypes;
    return list.filter((t) => board.spaces.some((s) => s.businessType === t));
  }, [board]);
  const current = type && types.includes(type) ? type : (types[0] ?? '');
  const spaces = (board?.spaces ?? []).filter((s) => s.businessType === current);
  // 5 秒刷新一次（setTick 让已用时长与估算跟着走）
  const now = Date.now();

  /** 刷手牌：有在用的台位就结束，没有就提示点一台空闲的 */
  const swipe = (code: string) => {
    const c = code.trim().toUpperCase();
    if (!c || !board) return;
    const using = board.spaces.find((s) => s.usage && s.usage.tagCode === c && types.includes(s.businessType));
    if (using?.usage) {
      setHint(null);
      setEnding(using.usage);
      return;
    }
    setHint(`手牌 ${c}：点一台空闲的${current}开始计时`);
  };

  const canSetup = session.permissions.includes('settings.manage');
  return (
    <div className="space-y-4" data-testid="leisure-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-[22px] font-bold">
          <Gamepad2 className="size-6 text-yuzu-deep" /> 休闲娱乐
        </h1>
        {canSetup && (
          <Button variant="secondary" onClick={() => setSetup(true)} data-testid="leisure-setup-open">
            <Wand2 className="size-4" /> 按价目表一键建
          </Button>
        )}
      </div>
      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,22rem)_1fr] md:items-center">
          <TagCardInput
            value={tag}
            onChange={(v) => {
              setTag(v);
              setHint(null);
            }}
            onCard={(found) => {
              setTag(found.tag.code);
              swipe(found.tag.code);
            }}
            onEnter={(e) => {
              e.preventDefault();
              swipe(tag);
            }}
            autoFocus
            placeholder="刷手牌开始 / 结束计时，回车"
            ariaLabel="手牌号"
            inputClassName="num text-[20px] font-bold"
            testId="leisure-tag"
          />
          <p className="text-[13px] text-ink-3">刷手牌：这张牌有在用的台位就结束计时，没有就点一台空闲的开始。费用结束时挂到手牌上，在前台一起结账。</p>
        </div>
        {hint && <Notice tone="info" title={hint} className="mt-3" />}
      </Card>
      {failed && <Notice tone="error" title={`取不到台位：${failed}`} />}
      {board && types.length === 0 && (
        <Notice tone="info" title="还没有休闲娱乐的台位">
          {canSetup ? '点右上角「按价目表一键建」，按价目表「娱乐价格」建网吧、桌球的台位与计费。' : '请店主在这一页按价目表一键建台位与计费。'}
        </Notice>
      )}
      {types.length > 0 && (
        <>
          <Segmented
            ariaLabel="娱乐类型"
            value={current}
            onChange={setType}
            options={types.map((t) => {
              const all = board!.spaces.filter((s) => s.businessType === t);
              return { value: t, label: `${t} ${all.filter((s) => s.usage).length}/${all.length}` };
            })}
          />
          {spaces[0]?.pricing && <p className="text-[13px] text-ink-3">{pricingText(spaces[0].pricing, formatYuan)}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6" data-testid="leisure-spaces">
            {spaces.map((s) => {
              const u = s.usage;
              const minutes = u ? usageMinutes(u, now) : 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  data-testid={`leisure-space-${s.code}`}
                  onClick={() => (u ? setEnding(u) : setOpening(s))}
                  className={`rounded-[14px] border p-3 text-left transition ${u ? 'border-clay/40 bg-clay/10' : 'border-pine/30 bg-pine/5 hover:bg-pine/10'}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <b className="num text-[18px]">{s.code}</b>
                    <span className={`text-[12px] font-bold ${u ? 'text-clay' : 'text-pine'}`}>{u ? '使用中' : '空闲'}</span>
                  </div>
                  {u ? (
                    <div className="mt-1 space-y-0.5 text-[13px]">
                      <p className="num">手牌 {u.tagCode}</p>
                      <p>{durationText(minutes)}</p>
                      {s.pricing && <p className="num font-bold">约 {formatYuan(usageEstimate(minutes, s.pricing))}</p>}
                    </div>
                  ) : (
                    <p className="mt-1 text-[13px] text-ink-3">{s.displayName}</p>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
      {opening && (
        <OpenUsageDialog
          space={opening}
          priced={opening.priced}
          initialTag={tag.trim().toUpperCase()}
          onClose={() => setOpening(null)}
          onDone={() => {
            setOpening(null);
            setTag('');
            setHint(null);
            void refresh();
          }}
        />
      )}
      {ending && (
        <CloseUsageFor
          usage={ending}
          mode="end"
          onClose={() => setEnding(null)}
          onDone={() => {
            setEnding(null);
            setTag('');
            void refresh();
          }}
        />
      )}
      {setup && (
        <SetupDialog
          onClose={() => setSetup(false)}
          onDone={() => {
            setSetup(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/** 按价目表一键建：选楼层、勾要建的、改编码前缀 */
function SetupDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'leisure-plan'], queryFn: () => api.get<LeisurePlan>('/api/admin/leisure/plan') });
  const plan = q.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [floor, setFloor] = useState<number | null>(null);
  const [edits, setEdits] = useState<Record<string, { on: boolean; prefix: string }>>({});
  const [busy, setBusy] = useState(false);
  const floorId = floor ?? plan?.floors[0]?.id ?? null;
  const picked: Record<string, { on: boolean; prefix: string }> = Object.fromEntries((plan?.rows ?? []).map((r) => [r.name, edits[r.name] ?? { on: !r.problem, prefix: r.prefix }]));
  const setPicked = setEdits;
  const chosen = plan?.rows.filter((r) => picked[r.name]?.on && !r.problem) ?? [];
  const submit = async () => {
    if (floorId === null) return;
    setBusy(true);
    try {
      const r = await api.post<LeisureSetupResult>('/api/admin/leisure/setup', { floorId, types: chosen.map((c) => ({ name: c.name, prefix: picked[c.name]!.prefix })) });
      toast({
        tone: 'success',
        title: `已设好 ${r.types.join('、')}：新建台位 ${r.created.length} 个${r.skipped.length ? `，跳过 ${r.skipped.length} 个（${r.skipped.map((s) => `${s.code} ${s.reason}`).join('；')}）` : ''}`,
      });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="按价目表一键建休闲娱乐"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={chosen.length === 0 || floorId === null} loading={busy} onClick={submit} data-testid="leisure-setup-submit">
            建 {chosen.length} 种
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[14px]">
        {error && <Notice tone="error" title={error} />}
        {q.error && <Notice tone="error" title={errorMessage(q.error)} />}
        {plan && !plan.catalogTitle && <Notice tone="warning" title="还没有生效中的价目表：先到「全品类价目表」导入「娱乐价格」并切换生效" />}
        {plan && plan.catalogTitle && plan.rows.length === 0 && <Notice tone="warning" title={`生效中的价目表「${plan.catalogTitle}」里没有按时长收费的娱乐（价格写成 39/2h 的那种）`} />}
        {plan && plan.rows.length > 0 && (
          <>
            <Field label="台位建在哪一层" htmlFor="leisure-floor">
              <Select id="leisure-floor" value={floorId ?? ''} onChange={(e) => setFloor(Number(e.target.value))}>
                {plan.floors.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.code} {f.name}
                  </option>
                ))}
              </Select>
            </Field>
            {plan.rows.map((r) => {
              const p = picked[r.name] ?? { on: false, prefix: r.prefix };
              return (
                <div key={r.name} className="rounded-[12px] border border-line p-3" data-testid={`leisure-plan-${r.name}`}>
                  <label className="flex items-center gap-2 font-bold">
                    <input type="checkbox" checked={p.on} disabled={!!r.problem} onChange={(e) => setPicked({ ...picked, [r.name]: { ...p, on: e.target.checked } })} />
                    {r.name}
                  </label>
                  <p className="mt-1 text-ink-2">
                    {durationText(r.minMinutes)} {formatYuan(r.basePrice)}，之后每 {r.stepMinutes} 分钟加 {formatYuan(r.extraPrice)}
                    {r.extraGuessed && '（价目表没写加钟，按基础价折算）'} · 价目表 {r.units} 台，台账已有 {r.existing} 台
                  </p>
                  {r.problem ? (
                    <Notice tone="warning" title={r.problem} className="mt-2" />
                  ) : (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-ink-3">编码前缀</span>
                      <Input aria-label={`${r.name}编码前缀`} value={p.prefix} onChange={(e) => setPicked({ ...picked, [r.name]: { ...p, prefix: e.target.value.toUpperCase() } })} className="w-24" />
                      <span className="num text-ink-3">{r.units > 0 ? `${leisureCode(p.prefix, 1)} … ${leisureCode(p.prefix, r.units)}` : '价目表没写台数，只设计费'}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </Dialog>
  );
}
