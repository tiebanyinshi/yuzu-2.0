// OA-06 员工「办公 → 打卡」（docs/OA.md 第 9 节）：现在的时间、考勤组与定位（最近的打卡点、距离、在不在范围内）、
// 这几天的排班与每条的上下班窗口和有效卡、大按钮「打卡」；在范围外时可以改成「外勤打卡」（事由 + 拍照）；下面是今天的明细。
// 打卡算哪一班的哪张卡由服务端按时间匹配（matchPunch），页面只显示结果。
// 打卡带操作编号、先记在本机再发（sendErpOp）；没收到结果的在页面上方查回、原样重提或作废，确认前不让再打。

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Fingerprint, LocateFixed, MapPin, RefreshCw, ScanFace } from 'lucide-react';
import { Link } from 'react-router';
import { clockText } from '@shared/technician-admin';
import { dateOfEpochMinute, distanceMeters, minuteOfEpochMinute, OUTWORK_REASON_MAX, PUNCH_KIND_LABELS, type OaPunch, type PunchResult, type PunchSlotView, type PunchToday } from '@shared/oa';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { uploadPhoto } from './oaImage';
import { Badge, Button, Card, Field, Notice, Skeleton, Textarea } from '../../components/ui';

const TODAY_KEY = ['oa', 'punch-today'] as const;

type Fix = { lat: number; lng: number; accuracy: number };
type Locate = { state: 'idle' | 'locating' } | { state: 'ok'; fix: Fix } | { state: 'failed'; message: string };

/**
 * 取一次定位（高精度，15 秒）；进页面时可以用半分钟内取过的，「重新定位」一定重新取。
 * 每次打卡前都再取一次（最多用 10 秒内的）：页面开着人走远了，不能拿进页面时的位置打卡（Codex 审查 10545e1）
 */
function useLocation() {
  const [loc, setLoc] = useState<Locate>({ state: 'idle' });
  const seq = useRef(0);
  const locate = (maximumAge = 30_000): Promise<Fix | null> =>
    new Promise((resolve) => {
      if (!('geolocation' in navigator)) {
        setLoc({ state: 'failed', message: '这个浏览器取不了位置' });
        resolve(null);
        return;
      }
      const mine = ++seq.current;
      setLoc({ state: 'locating' });
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
          if (mine === seq.current) setLoc({ state: 'ok', fix });
          resolve(fix);
        },
        (e) => {
          if (mine === seq.current) setLoc({ state: 'failed', message: e.code === e.PERMISSION_DENIED ? '没有允许取位置：请在浏览器设置里允许这个网站使用位置' : '没取到位置，请到开阔处再试' });
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 15_000, maximumAge },
      );
    });
  // 进页面就取一次
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void locate(), []);
  return { loc, locate };
}

/** 现在的钟点（门店所在地）：服务端给的「第几分钟」加上进页面以后过了多久，每 20 秒走一次 */
function useClock(base: number | undefined) {
  const started = useRef(Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    started.current = Date.now();
    const t = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [base]);
  return base === undefined ? undefined : base + Math.floor((Date.now() - started.current) / 60_000);
}

const dayLabel = (date: string, today: string) => {
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return diff === 0 ? '今天' : diff === -1 ? '昨天' : diff === 1 ? '明天' : date.slice(5);
};
/** 「1970-01-01 起第几分钟」写成「（前一天）22:00」这样 */
const at = (m: number, date: string) => {
  const d = dateOfEpochMinute(m);
  const prefix = d === date ? '' : d < date ? '前一天 ' : '次日 ';
  return `${prefix}${clockText(minuteOfEpochMinute(m))}`;
};

function punchNote(p: OaPunch) {
  const bits = [p.lateMinutes ? `迟到 ${p.lateMinutes} 分钟` : '', p.earlyMinutes ? `早退 ${p.earlyMinutes} 分钟` : '', p.outwork ? '外勤' : ''].filter(Boolean);
  return bits.join('、');
}

export function PunchPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const q = useQuery({ queryKey: TODAY_KEY, queryFn: () => api.get<PunchToday>('/api/oa/attendance/today') });
  const data = q.data;
  const now = useClock(data?.now);
  const { loc, locate } = useLocation();
  // 只看本人的：同一台电脑换人登录后，上一位没确认的打卡不挡这一位（上一位登录回来照样能处理）
  const mine = (op: { staffId?: number }) => op.staffId === session.staff.id;
  const pending = useErpRecorded(['oa_punch']).filter(mine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<PunchResult | null>(null);
  const [outwork, setOutwork] = useState(false);
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState<{ file: File; preview: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // 考勤组要人脸的（OA-07）：打卡前先自拍一张（前置摄像头），随打卡一起交给服务端比对
  const [selfie, setSelfie] = useState<{ file: File; preview: string } | null>(null);
  const selfieInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => (selfie ? URL.revokeObjectURL(selfie.preview) : undefined), [selfie]);
  useEffect(() => () => (photo ? URL.revokeObjectURL(photo.preview) : undefined), [photo]);

  const group = data?.group ?? null;
  const fix = loc.state === 'ok' ? loc.fix : null;
  // 在任何一个打卡点的范围里就算在范围内（与服务端一致）；显示范围内最近的那个，都不在就显示最近的
  const measured = fix && group ? group.locations.map((l) => ({ ...l, distance: distanceMeters(fix, l) })).sort((a, b) => a.distance - b.distance) : [];
  const inRange = measured.some((l) => l.distance <= l.radiusM);
  const nearest = measured.find((l) => l.distance <= l.radiusM) ?? measured[0] ?? null;
  const needFix = !!group?.gpsRequired;
  const needFace = !!group?.faceRequired;
  const faceOk = data?.face === 'approved';

  const send = async (extra: { outwork?: { reason: string; photoId: number } }) => {
    if (pending.length) {
      setError('上一次打卡结果待确认：请先在页面上方查回、按原内容重新提交或作废，再打');
      return;
    }
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      // 每次打卡前重新取一次位置（最多用 10 秒内的）；记在本机的原请求带着这次的位置，结果待确认重提时原样用
      const here = await locate(10_000);
      if (needFix && !here) {
        setError('没取到当前位置：这个考勤组打卡要定位，请到开阔处、允许取位置后再打');
        return;
      }
      let faceImageId: number | undefined;
      if (needFace) {
        if (!selfie) {
          setError('这个考勤组打卡要先自拍一张');
          return;
        }
        try {
          faceImageId = (await uploadPhoto(selfie.file, `打卡自拍-${data.today}.jpg`)).id;
        } catch (e) {
          setError(`自拍没传上：${errorMessage(e)}`);
          return;
        }
      }
      const key = uuid();
      const r = await sendErpOp<PunchResult>({
        key,
        type: 'oa_punch',
        url: '/api/oa/attendance/punch',
        body: {
          clientKey: key,
          storeId: session.store.id,
          ...(here ? { lat: Number(here.lat.toFixed(6)), lng: Number(here.lng.toFixed(6)), accuracy: Math.round(here.accuracy) } : {}),
          device: `${navigator.platform || ''} ${screen.width}×${screen.height}`.trim().slice(0, 200),
          ...(faceImageId ? { faceImageId } : {}),
          ...extra,
        },
        summary: `${extra.outwork ? '外勤打卡' : '打卡'} · ${data.today}`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      setLast(r);
      setOutwork(false);
      setReason('');
      setPhoto(null);
      setSelfie(null);
      const p = r.punch;
      const note = punchNote(p);
      toast({ tone: p.lateMinutes || p.earlyMinutes ? 'info' : 'success', title: `${PUNCH_KIND_LABELS[p.kind]} ${p.localTime}${p.shiftName ? ` · ${p.shiftName}` : ''}`, body: note || undefined });
      void qc.invalidateQueries({ queryKey: TODAY_KEY });
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '打卡结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废；确认前不要再打一次。' });
      } else if (e instanceof ApiError && e.code === 'LOCATION_OUT') {
        setError(e.message);
        setOutwork(true);
      } else if (e instanceof ApiError && (e.code === 'FACE_MISMATCH' || e.code === 'ATTACHMENT_INVALID')) {
        // 自拍不能再用（比对没过，或已经挂到别的打卡上）：清掉，重拍
        setError(e.message);
        setSelfie(null);
      } else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const sendOutwork = async () => {
    if (!photo || !reason.trim()) return;
    setBusy(true);
    setError(null);
    let photoId: number;
    try {
      const up = await uploadPhoto(photo.file, `外勤-${data?.today ?? ''}.jpg`);
      photoId = up.id;
    } catch (e) {
      setError(`照片没传上：${errorMessage(e)}`);
      setBusy(false);
      return;
    }
    setBusy(false);
    await send({ outwork: { reason: reason.trim(), photoId } });
  };

  return (
    <>
      <PageHeader dateMode="calendar" title="打卡" subtitle="按排班的上下班窗口算是哪一班的卡；上班卡取第一次、下班卡取最后一次" />
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-7">
        <ErpPendingPanel types={['oa_punch']} filter={mine} className="space-y-2" onFound={() => void qc.invalidateQueries({ queryKey: TODAY_KEY })} />
        {q.isPending ? (
          <Skeleton className="h-72" />
        ) : q.isError && !data ? (
          <LoadFailed title="打卡信息没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : !group ? (
          <EmptyState title="你还没进这家门店的考勤组" description="进了考勤组才能打卡，请找人事把你加进去。" testId="punch-no-group" />
        ) : (
          <>
            <Card className="p-5" data-testid="punch-card">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-[13px] text-ink-3">
                    {data!.today} · {group.name}
                  </p>
                  <p className="num text-[40px] leading-none font-bold text-ink" data-testid="punch-clock">
                    {now === undefined ? '--:--' : clockText(minuteOfEpochMinute(now))}
                  </p>
                </div>
                <div className="text-right text-[13px]" data-testid="punch-location">
                  {loc.state === 'locating' || loc.state === 'idle' ? (
                    <span className="text-ink-3">正在取位置…</span>
                  ) : loc.state === 'failed' ? (
                    <span className="text-clay">{loc.message}</span>
                  ) : nearest ? (
                    <span className={inRange ? 'text-pine' : 'text-ember'}>
                      <MapPin className="mr-1 inline size-4" />
                      {inRange ? '在范围内' : '不在范围内'} · 离「{nearest.name}」{nearest.distance} 米（范围 {nearest.radiusM} 米）
                    </span>
                  ) : (
                    <span className="text-ink-3">已取到位置（精度约 {Math.round(fix!.accuracy)} 米）</span>
                  )}
                  <div>
                    <Button size="sm" variant="ghost" icon={<LocateFixed className="size-4" />} onClick={() => void locate(0)} disabled={loc.state === 'locating'} data-testid="punch-relocate">
                      重新定位
                    </Button>
                  </div>
                </div>
              </div>
              {!needFix && <p className="mt-2 text-[12px] text-ink-3">这个考勤组不要求定位，取到了也会记下。</p>}
              {error && (
                <Notice tone="error" className="mt-3" data-testid="punch-error">
                  {error}
                </Notice>
              )}
              {needFace &&
                (faceOk ? (
                  <div className="mt-3 flex flex-wrap items-center gap-3" data-testid="punch-face">
                    <input
                      ref={selfieInput}
                      type="file"
                      accept="image/*"
                      capture="user"
                      className="hidden"
                      data-testid="punch-selfie-input"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) setSelfie({ file: f, preview: URL.createObjectURL(f) });
                      }}
                    />
                    <Button variant="secondary" icon={<ScanFace className="size-4" />} onClick={() => selfieInput.current?.click()} data-testid="punch-selfie">
                      {selfie ? '重拍' : '自拍一张'}
                    </Button>
                    {selfie ? (
                      <img src={selfie.preview} alt="打卡自拍" className="size-14 rounded-md object-cover" />
                    ) : (
                      <span className="text-[13px] text-ink-3">这个考勤组要人脸：先自拍一张再打卡</span>
                    )}
                  </div>
                ) : (
                  <Notice tone="warning" className="mt-3" data-testid="punch-face-missing">
                    这个考勤组打卡要人脸，你的人脸录入{data!.face === 'pending' ? '还在等审核' : '还没通过'}。
                    <Link to="/oa/face" className="ml-1 font-semibold text-lake underline">
                      去人脸录入
                    </Link>
                  </Notice>
                ))}
              <Button
                variant="primary"
                size="lg"
                className="mt-4 h-16 w-full text-[18px]"
                icon={<Fingerprint className="size-6" />}
                loading={busy && !outwork}
                disabled={busy || (needFix && !fix) || (needFace && (!faceOk || !selfie))}
                onClick={() => void send({})}
                data-testid="punch-button"
              >
                打卡
              </Button>
              {needFix && !fix && loc.state !== 'locating' && <p className="mt-2 text-center text-[12px] text-ink-3">这个考勤组打卡要定位：取到位置以后才能打。</p>}
              {last && (
                <p className="mt-3 text-center text-[13px] text-ink-2" data-testid="punch-last">
                  刚才：{PUNCH_KIND_LABELS[last.punch.kind]} {last.punch.localTime}
                  {last.punch.shiftName ? ` · ${last.punch.shiftName}` : ''}
                  {punchNote(last.punch) ? `（${punchNote(last.punch)}）` : ''}
                  {last.effective && last.effective.id !== last.punch.id ? `；有效卡仍是 ${last.effective.localTime}` : ''}
                </p>
              )}
            </Card>

            {outwork && fix && (
              <Card className="space-y-3 p-5" data-testid="punch-outwork">
                <p className="font-semibold text-ink">外勤打卡</p>
                <p className="text-[13px] text-ink-3">在外面办事的写清楚事由、拍一张照片；位置照样记下，是否算正常出勤由人事在考勤里确认。</p>
                <Field label="外勤事由" htmlFor="outwork-reason">
                  <Textarea id="outwork-reason" rows={2} maxLength={OUTWORK_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="outwork-reason" />
                </Field>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  data-testid="outwork-photo"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) setPhoto({ file: f, preview: URL.createObjectURL(f) });
                  }}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="secondary" icon={<Camera className="size-4" />} onClick={() => fileInput.current?.click()}>
                    {photo ? '重拍' : '拍照'}
                  </Button>
                  {photo && <img src={photo.preview} alt="外勤照片" className="size-16 rounded-md object-cover" />}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setOutwork(false)}>
                    取消
                  </Button>
                  <Button variant="primary" loading={busy} disabled={busy || !photo || !reason.trim()} onClick={() => void sendOutwork()} data-testid="outwork-submit">
                    外勤打卡
                  </Button>
                </div>
              </Card>
            )}

            <Card className="p-5" data-testid="punch-slots">
              <div className="mb-2 flex items-center justify-between">
                <p className="font-semibold text-ink">这几天的排班</p>
                <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => void q.refetch()} aria-label="刷新" />
              </div>
              {data!.slots.length === 0 ? (
                <p className="text-[13px] text-ink-3">这几天没有排班（休息）。休息日打的卡记为休息日打卡。</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data!.slots.map((s) => (
                    <SlotRow key={`${s.date}-${s.shiftId}`} slot={s} today={data!.today} now={now} />
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-5" data-testid="punch-records">
              <p className="mb-2 font-semibold text-ink">今天的打卡明细</p>
              {data!.punches.length === 0 ? (
                <p className="text-[13px] text-ink-3">今天还没有打卡。</p>
              ) : (
                <ul className="space-y-1.5 text-[13px]">
                  {[...data!.punches].reverse().map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2">
                      <span className="num font-semibold text-ink">{p.localTime}</span>
                      <Badge tone={p.kind === 'in' || p.kind === 'out' ? 'lake' : 'neutral'}>{PUNCH_KIND_LABELS[p.kind]}</Badge>
                      {p.shiftName && <span className="text-ink-2">{p.shiftName}</span>}
                      {punchNote(p) && <span className="text-ember">{punchNote(p)}</span>}
                      {p.locationName && p.distanceM !== null && (
                        <span className="text-ink-3">
                          离「{p.locationName}」{p.distanceM} 米
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </>
  );
}

function SlotRow({ slot: s, today, now }: { slot: PunchSlotView; today: string; now: number | undefined }) {
  const w = s.windows;
  const state = (kind: 'in' | 'out') => {
    const p = kind === 'in' ? s.in : s.out;
    if (p)
      return (
        <span className="text-pine">
          已打 {p.localTime}
          {punchNote(p) ? `（${punchNote(p)}）` : ''}
        </span>
      );
    const [from, to] = kind === 'in' ? [w.inFrom, w.inTo] : [w.outFrom, w.outTo];
    if (now === undefined || now < from) return <span className="text-ink-3">未到时间</span>;
    if (now <= to) return <span className="font-semibold text-ember">现在可以打</span>;
    return <span className="text-clay">没打</span>;
  };
  return (
    <li className="py-2.5" data-testid={`punch-slot-${s.date}-${s.shiftId}`}>
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={s.date === today ? 'pine' : 'neutral'}>{dayLabel(s.date, today)}</Badge>
        <span className="font-semibold text-ink">{s.name}</span>
        <span className="num text-[13px] text-ink-3">
          {clockText(s.startMinute)}–{s.endMinute <= s.startMinute ? '次日 ' : ''}
          {clockText(s.endMinute)}
        </span>
      </p>
      <div className={cn('mt-1 grid gap-1 text-[13px] sm:grid-cols-2')}>
        <p>
          <span className="text-ink-3">
            上班卡 {at(w.inFrom, s.date)}–{at(w.inTo, s.date)}：
          </span>
          {state('in')}
        </p>
        <p>
          <span className="text-ink-3">
            下班卡 {at(w.outFrom, s.date)}–{at(w.outTo, s.date)}：
          </span>
          {state('out')}
        </p>
      </div>
    </li>
  );
}
