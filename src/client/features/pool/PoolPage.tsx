// 8.2.21 男汤 / 女汤泡池（docs/V82221_POOL.md）：泡池区输单——先刷客人手牌、选项目、再刷技师工牌，点「派钟上钟」。
//   · 下单就是钟房的派钟（挂到客人手牌账单上、建钟单、立即上钟），服务记进这位技师的业绩明细；轮钟照排位核对，客人点名的选点钟；
//   · 读卡器刷到的卡：第一步认手牌、第三步认技师工牌；也能手输牌号、工号；
//   · 技师管理的岗位可以在这里给技师「绑工牌」（刷一下卡就绑上）。
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Bath, IdCard } from 'lucide-react';
import { tierPrice, type PriceTier } from '@shared/catalog';
import { createWedgeRecognizer, WEDGE_MAX_GAP_MS } from '@shared/devices';
import type { ClockroomBoard } from '@shared/clockroom';
import { formatYuan } from '@shared/money';
import { POOL_SIDE_LABELS, type PoolGuest, type PoolSide, type PoolTechnician } from '@shared/pool';
import { CALL_TYPE_LABELS, canServe, tierFor, type CallType } from '@shared/technicians';
import { api, errorMessage } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useCatalog } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, Notice, Segmented, Select } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { TagCardInput, useCardReader } from '../frontdesk/TagCardInput';

const doneOnFound = (found: { found: true } | { found: false }) => (found.found && 'visit' in found ? true : null);

export function PoolPage() {
  const session = useSession();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [side, setSide] = useState<PoolSide>('male');
  const [tagText, setTagText] = useState('');
  const [guest, setGuest] = useState<PoolGuest | null>(null);
  const [itemId, setItemId] = useState<number | null>(null);
  const [techText, setTechText] = useState('');
  const [tech, setTech] = useState<PoolTechnician | null>(null);
  const [callType, setCallType] = useState<CallType>('rotation');
  // 8.2.21（Codex 审查）：不按技师等级定价、项目有几档价时，照钟房的派钟让人选价格档
  const [pickTier, setPickTier] = useState<PriceTier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [binding, setBinding] = useState(false);
  const catalog = useCatalog();
  const board = useQuery({ queryKey: ['clockroom'], queryFn: () => api.get<ClockroomBoard>('/api/clockroom') });
  // 8.2.21（Codex 审查）：钟房那边下钟了，这边也要看得到（15 秒刷一次；后台、断网时不取）；刷工牌时也重取
  useLivePoll(
    async () => {
      await qc.invalidateQueries({ queryKey: ['clockroom'] });
    },
    [qc],
    { intervalMs: 15_000 },
  );
  const op = useFrontdeskOp<true>({ type: 'bill_post', visitId: guest?.visitId ?? null, staffName: session.staff.displayName, pick: doneOnFound });

  const items = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.active && i.technicianRequired && (!i.gender || i.gender === side)), [catalog.data, side]);
  const item = items.find((i) => i.id === itemId) ?? null;
  const boardTech = tech ? (board.data?.technicians.find((t) => t.id === tech.id) ?? null) : null;
  const tierByGrade = board.data?.techRules.tierByGrade ?? false;
  const baseTier = item ? (pickTier && item.prices.some((p) => p.tier === pickTier) ? pickTier : item.prices[0]!.tier) : null;
  const tier = item && baseTier ? (boardTech ? tierFor(boardTech, item, baseTier, tierByGrade) : baseTier) : null;
  const unit = item && tier ? tierPrice(item.prices, tier) : null;
  const step = !guest ? 1 : !item ? 2 : !tech ? 3 : 4;

  const lookGuest = async (q: { code?: string; uid?: string }) => {
    setError(null);
    try {
      const g = await api.get<PoolGuest>(`/api/pool/guest?${new URLSearchParams(q as Record<string, string>)}`);
      setGuest(g);
      setTagText(g.tagCode);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const lookTech = async (q: { code?: string; uid?: string }) => {
    setError(null);
    try {
      const t = await api.get<PoolTechnician>(`/api/pool/technician?${new URLSearchParams(q as Record<string, string>)}`);
      setTech(t);
      setTechText(t.techNo);
      void qc.invalidateQueries({ queryKey: ['clockroom'] });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  // 8.2.21（Codex 审查）：光标在工号框里时键盘式读卡器打进来的一串按芯片号查，人敲的按工号查
  const techBurst = useRef({ wedge: createWedgeRecognizer(), prefix: '', last: -Infinity });
  // 第三步（选好项目以后）：读卡器刷到的认技师工牌；第一步由手牌框自己收
  useCardReader(step === 3 && !binding, { onCard: (uid) => void lookTech({ uid }), onReadError: (m) => setError(m) });

  const reset = () => {
    setGuest(null);
    setTagText('');
    setItemId(null);
    setPickTier(null);
    setTech(null);
    setTechText('');
    setCallType('rotation');
    setError(null);
  };
  const problem = !guest
    ? '先刷客人手牌'
    : !item
      ? '选一个项目'
      : !tech
        ? '刷技师工牌或输入工号'
        : !boardTech
          ? '这位技师不在钟房的名单里，请刷新'
          : (canServe(boardTech, item, tierByGrade) ?? (boardTech.busy ? `${boardTech.techNo} 号正在钟上` : null));
  const submit = async () => {
    if (problem || !guest || !item || !boardTech || unit === null) return;
    const ok = await op.submit((key) => ({
      url: '/api/clockroom/dispatch',
      body: {
        clientKey: key,
        visitId: guest.visitId,
        itemId: item.id,
        tier: tierByGrade && item.prices.length > 1 ? undefined : (tier ?? undefined),
        quantity: 1,
        technicianId: boardTech.id,
        callType,
        startNow: true,
        expectedTotal: unit,
      },
      tagCodes: [guest.tagCode],
      summary: `泡池 ${item.name}（${boardTech.techNo} 号 ${boardTech.name} · ${CALL_TYPE_LABELS[callType]}）`,
      amount: unit,
    }));
    if (ok) {
      toast({ tone: 'success', title: `${guest.tagCode} ${item.name} 已上钟`, body: `${boardTech.techNo} 号 ${boardTech.name}，记进技师业绩` });
      void qc.invalidateQueries({ queryKey: ['clockroom'] });
      reset();
    }
  };

  const zoneMismatch = guest && guest.zone !== side;
  return (
    <div className="space-y-4" data-testid="pool-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-[22px] font-bold">
          <Bath className="size-6 text-yuzu-deep" /> 泡池
        </h1>
        <div className="flex items-center gap-2">
          <Segmented
            ariaLabel="男汤女汤"
            value={side}
            onChange={(v) => {
              setSide(v);
              setItemId(null);
            }}
            options={[
              { value: 'male', label: POOL_SIDE_LABELS.male },
              { value: 'female', label: POOL_SIDE_LABELS.female },
            ]}
          />
          {can('technician.manage') && (
            <Button variant="secondary" onClick={() => setBinding(true)} data-testid="pool-bind-open">
              <IdCard className="size-4" /> 绑工牌
            </Button>
          )}
        </div>
      </div>
      {error && <Notice tone="error" title={error} />}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className={`p-4 ${step === 1 ? 'ring-2 ring-yuzu' : ''}`}>
          <h2 className="text-[16px] font-bold">① 刷客人手牌</h2>
          <div className="mt-3">
            <TagCardInput
              value={tagText}
              onChange={(v) => {
                setTagText(v);
                setGuest(null);
              }}
              onCard={(found) => void lookGuest({ code: found.tag.code })}
              onEnter={(e) => {
                e.preventDefault();
                if (tagText.trim()) void lookGuest({ code: tagText.trim() });
              }}
              listening={step === 1}
              autoFocus
              placeholder="刷手牌或输入牌号，回车"
              ariaLabel="客人手牌号"
              inputClassName="num text-[20px] font-bold"
              testId="pool-guest"
            />
          </div>
          {guest && (
            <p className="mt-3 flex items-center gap-2 text-[15px]" data-testid="pool-guest-ok">
              <BadgeCheck className="size-5 text-pine" />
              <b className="num">{guest.tagCode}</b> {guest.ticketName ?? ''}
            </p>
          )}
          {zoneMismatch && <Notice tone="warning" title={`这位客人不是${POOL_SIDE_LABELS[side]}的手牌，请核对`} className="mt-2" />}
        </Card>
        <Card className={`p-4 ${step === 2 ? 'ring-2 ring-yuzu' : ''}`}>
          <h2 className="text-[16px] font-bold">② 选项目</h2>
          <div className="mt-3 grid grid-cols-2 gap-2" data-testid="pool-items">
            {items.map((i) => (
              <button
                key={i.id}
                type="button"
                disabled={!guest}
                onClick={() => {
                  setItemId(i.id);
                  setPickTier(null);
                }}
                className={`rounded-[12px] border p-2 text-left text-[14px] ${i.id === itemId ? 'border-yuzu-deep bg-yuzu/15 font-bold' : 'border-line'} disabled:opacity-50`}
              >
                {i.name}
                <span className="num block text-[12px] text-ink-3">{formatYuan(i.prices[0]?.price ?? 0)}</span>
              </button>
            ))}
            {items.length === 0 && <p className="col-span-2 text-[13px] text-ink-3">没有{POOL_SIDE_LABELS[side]}能做的技师项目（价目表里「需要技师」、性别不限或同性别的项目）</p>}
          </div>
          {item && !tierByGrade && item.prices.length > 1 && (
            <div className="mt-3" data-testid="pool-tier">
              <Segmented
                ariaLabel="价格档"
                value={baseTier ?? item.prices[0]!.tier}
                onChange={setPickTier}
                options={item.prices.map((p) => ({ value: p.tier, label: `${{ standard: '标准', professional: '专业', premium: '优选' }[p.tier]} ${formatYuan(p.price)}` }))}
              />
            </div>
          )}
        </Card>
        <Card className={`p-4 ${step >= 3 ? 'ring-2 ring-yuzu' : ''}`}>
          <h2 className="text-[16px] font-bold">③ 刷技师工牌</h2>
          <Input
            className="mt-3"
            value={techText}
            onChange={(e) => {
              setTechText(e.target.value);
              setTech(null);
            }}
            onKeyDown={(e) => {
              const b = techBurst.current;
              if (e.timeStamp - b.last > WEDGE_MAX_GAP_MS) b.prefix = techText;
              b.last = e.timeStamp;
              const scanned = b.wedge.feed(e.key, e.timeStamp);
              if (e.key !== 'Enter') return;
              if (scanned) {
                e.preventDefault();
                setTechText(b.prefix);
                void lookTech({ uid: scanned });
              } else if (techText.trim()) {
                e.preventDefault();
                void lookTech({ code: techText.trim() });
              }
            }}
            disabled={!item}
            placeholder="刷工牌，或输入工号回车"
            aria-label="技师工号"
            data-testid="pool-tech"
          />
          {boardTech && (
            <p className="mt-3 text-[15px]" data-testid="pool-tech-ok">
              <b className="num">{boardTech.techNo}</b> 号 {boardTech.nickname || boardTech.name}
            </p>
          )}
          <div className="mt-3">
            <Segmented
              ariaLabel="上钟方式"
              value={callType}
              onChange={setCallType}
              options={[
                { value: 'rotation', label: CALL_TYPE_LABELS.rotation },
                { value: 'designated', label: `${CALL_TYPE_LABELS.designated}（客人点名）` },
              ]}
            />
          </div>
          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="text-[14px]">{unit !== null ? <b className="num text-[18px]">{formatYuan(unit)}</b> : null}</span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={reset} disabled={op.busy}>
                重来
              </Button>
              <Button variant="primary" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="pool-submit">
                派钟上钟
              </Button>
            </div>
          </div>
          {problem && guest && <p className="mt-2 text-[13px] text-ink-3">{problem}</p>}
          <PendingPanel op={op} onResolved={reset} />
          {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-2" />}
        </Card>
      </div>
      {binding && board.data && <BindCardDialog technicians={board.data.technicians} onClose={() => setBinding(false)} />}
    </div>
  );
}

/** 给技师绑工牌：选技师、刷卡（或手输芯片号） */
function BindCardDialog({ technicians, onClose }: { technicians: ClockroomBoard['technicians']; onClose: () => void }) {
  const toast = useToast();
  const [techId, setTechId] = useState<number | null>(technicians[0]?.id ?? null);
  const [uid, setUid] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useCardReader(true, { onCard: (u) => setUid(u), onReadError: (m) => setError(m) });
  const save = async (value: string | null) => {
    if (techId === null) return;
    setBusy(true);
    setError(null);
    try {
      const t = await api.put<PoolTechnician>(`/api/technicians/${techId}/card`, { uid: value });
      toast({ tone: 'success', title: value ? `${t.techNo} 号 ${t.name} 的工牌已绑上` : `${t.techNo} 号 ${t.name} 的工牌已解绑` });
      onClose();
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
      title="绑技师工牌"
      description="选技师，把工牌放到读卡器上（或手输芯片号），点「绑上」。之后泡池区刷这张卡就认这位技师。"
      footer={
        <>
          <Button variant="ghost" onClick={() => void save(null)} disabled={busy || techId === null}>
            解绑
          </Button>
          <Button variant="primary" onClick={() => void save(uid.trim())} disabled={!uid.trim() || techId === null} loading={busy} data-testid="pool-bind-submit">
            绑上
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Notice tone="error" title={error} />}
        <Field label="技师" htmlFor="pool-bind-tech">
          <Select id="pool-bind-tech" value={techId ?? ''} onChange={(e) => setTechId(Number(e.target.value))}>
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.techNo} 号 {t.nickname || t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="工牌芯片号" htmlFor="pool-bind-uid">
          <Input id="pool-bind-uid" value={uid} onChange={(e) => setUid(e.target.value)} placeholder="刷卡自动填" />
        </Field>
      </div>
    </Dialog>
  );
}
