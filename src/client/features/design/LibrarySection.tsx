// Design → 素材库（店主 2026-11-24，docs/BOARDS.md 第 4、9 节）：两个页签——
//   · 用途：每个用途一张卡，写现在用的哪份素材、谁什么时候换的；「换」从库里选同一种的素材，「切回上一份」「不用素材」一点就换；
//     素材出了新版本时提示，点了才换（用途不跟着悄悄变）。
//   · 素材：字体、图片、视频按种类筛，网格看；拖进来或点「上传」；点开一份看各版、用在哪、改名字与说明、传新版、归档。
// 切换带操作编号：先在本机记下这一笔再发，结果不确定时原样重提（同一个编号不会换两次，AGENTS.md「结果待确认」）。

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowLeftRight, Film, Image as ImageIcon, RotateCcw, Type, Upload } from 'lucide-react';
import { DESIGN_KIND_LABELS, DESIGN_LIMITS, designFileUrl, type DesignAsset, type DesignAssetDetail, type DesignAssetKind, type DesignSlot, type DesignSlotState } from '@shared/design';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useSessionQuery } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Skeleton, Textarea } from '../../components/ui';
import { SubPane } from '../../components/SubNav';
import { AdminPage } from '../admin/AdminShell';

const TABS = [
  { key: 'slots', label: '用途' },
  { key: 'assets', label: '素材' },
];
const keys = { slots: ['design', 'slots'] as const, assets: (kind: string, archived: boolean, search: string) => ['design', 'assets', kind, archived, search] as const };
/** 与服务端 DESIGN_PAGE_SIZE 一致：一页满了才可能还有更早的 */
const PAGE_SIZE = 60;

/** 素材列表：按编号从新到旧一页 60 条，「加载更早的」往前翻；可按名字、标签搜（Codex 审查：不再一次截到 500 条） */
function useAssetList(kind: DesignAssetKind, archived: boolean, search: string) {
  const q = useInfiniteQuery({
    queryKey: keys.assets(kind, archived, search),
    queryFn: ({ pageParam }) =>
      api.get<DesignAsset[]>(`/api/design/assets?kind=${kind}&archived=${archived ? 1 : 0}${search ? `&q=${encodeURIComponent(search)}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length >= PAGE_SIZE ? last[last.length - 1]!.id : undefined),
  });
  return { ...q, items: q.data?.pages.flat() ?? [] };
}

function MoreAssets({ q }: { q: ReturnType<typeof useAssetList> }) {
  if (!q.hasNextPage) return null;
  return (
    <div className="pt-2 text-center">
      <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} data-testid="design-assets-more">
        加载更早的
      </Button>
    </div>
  );
}
const KIND_ICON = { font: Type, image: ImageIcon, video: Film } as const;
const ACCEPT: Record<DesignAssetKind, string> = { font: '.woff2,.woff,.otf,.ttf', image: 'image/png,image/jpeg,image/webp,image/svg+xml', video: 'video/mp4,video/webm' };
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;

export function LibrarySection() {
  return (
    <AdminPage section="library" wide tabs={TABS} description="字体、图片、视频存在这里；每个用途选一份当前用的，一点就换，随时切回。">
      <SubPane tab="slots">
        <SlotsPane />
      </SubPane>
      <SubPane tab="assets">
        <AssetsPane />
      </SubPane>
    </AdminPage>
  );
}

// ───────────────────────── 预览 ─────────────────────────

function Preview({ versionId, kind, mime, className }: { versionId: number; kind: DesignAssetKind; mime?: string; className?: string }) {
  const url = designFileUrl(versionId);
  if (kind === 'image') return <img src={url} alt="" loading="lazy" className={cn('h-full w-full object-contain', className)} />;
  if (kind === 'video') return <video src={url} muted loop playsInline preload="metadata" className={cn('h-full w-full object-cover', className)} />;
  return <FontSample versionId={versionId} mime={mime} className={className} />;
}

/** 字体样张：把这一版的字体临时加进页面再写一行字 */
function FontSample({ versionId, className }: { versionId: number; mime?: string; className?: string }) {
  const family = `yuzu-design-${versionId}`;
  return (
    <div className={cn('flex h-full w-full flex-col items-center justify-center gap-1 px-3 text-center', className)}>
      <style>{`@font-face{font-family:"${family}";src:url("${designFileUrl(versionId)}");font-display:swap}`}</style>
      <span className="truncate text-[26px] leading-tight text-ink" style={{ fontFamily: `"${family}", serif` }}>
        Tangqi Spa 128
      </span>
      <span className="truncate text-[15px] text-ink-2" style={{ fontFamily: `"${family}", serif` }}>
        柚子 · 汤泉 ¥ 88.00
      </span>
    </div>
  );
}

// ───────────────────────── 用途 ─────────────────────────

const PENDING_KEY = 'yuzu.design.pendingAssign';
interface PendingAssign {
  slot: DesignSlot;
  /** 发起时的门店（Codex 审查）：用途按门店分开设，换了门店不能在别的店重提、作废这一笔 */
  storeName: string;
  body: { versionId: number | null; fromVersionId: number | null; opKey: string; reason: string; storeId: number };
}
const readPending = (): PendingAssign | null => {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingAssign) : null;
  } catch {
    return null;
  }
};
const writePending = (p: PendingAssign | null): boolean => {
  try {
    // 写完读回核对：浏览器悄悄丢了写入（存储满、被清）也当记不下，不发请求
    const text = p ? JSON.stringify(p) : null;
    if (text) localStorage.setItem(PENDING_KEY, text);
    else localStorage.removeItem(PENDING_KEY);
    return localStorage.getItem(PENDING_KEY) === text;
  } catch {
    return false;
  }
};

/** 只在本机记录还是这一笔时才删（Codex 审查：两个窗口时，别的窗口可能已经换成了另一笔待确认的，不能误删） */
const clearPendingIf = (opKey: string) => {
  if (readPending()?.body.opKey === opKey) writePending(null);
};

function useAssign() {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSessionQuery().data;
  const store = session?.store ?? null;
  const [pending, setPending] = useState<PendingAssign | null>(readPending);
  const [busy, setBusy] = useState(false);
  // 同一台电脑开了几个窗口（Codex 审查）：别的窗口改了本机记录，这里跟着换，显示的永远是存着的那一笔
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === PENDING_KEY || e.key === null) setPending(readPending());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  /** 页面上显示的那一笔与本机存着的不是同一笔（别的窗口处理过）：换成存着的，这次不动 */
  const stale = (p: PendingAssign) => {
    const stored = readPending();
    if (stored?.body.opKey === p.body.opKey) return false;
    setPending(stored);
    toast({ tone: 'info', title: '另一个窗口已经处理过这一笔', body: stored ? '现在显示的是本机存着的那一笔，请再看一眼' : '本机已经没有待确认的切换了' });
    return true;
  };
  /** retry：从「结果待确认」里原样重提（第一次提交被明确拒绝才清本机记录；重提被拒不能断定原来那次不会生效，留着，查回或确认作废） */
  const send = async (p: PendingAssign, retry = false) => {
    // 上一笔结果还没确认时不许再换（Codex 审查）：本机只记一笔，新的一笔会把原来那笔的编号与内容盖掉，原请求晚到就没法查回、作废。
    // 以本机存着的为准（别的窗口可能刚记下一笔）
    const stored = readPending();
    if (!retry && stored) {
      setPending(stored);
      toast({ tone: 'error', title: '上一次切换还没确认结果', body: '先在上面查回、原样重提或确认作废，再换别的' });
      return;
    }
    // 重提只重提本机存着的那一笔：别的窗口已经换成另一笔的，不盖掉它
    if (retry && stale(p)) return;
    // 先在本机记下这一笔（编号与内容），记不下就不发（AGENTS.md「结果待确认」）
    if (!retry && !writePending(p)) {
      toast({ tone: 'error', title: '这台电脑存不了本机记录（浏览器设置或隐私模式），没有发出去；换一台或改设置再试' });
      return;
    }
    setPending(p);
    setBusy(true);
    try {
      await api.post(`/api/design/slots/${p.slot}/assign`, p.body);
      clearPendingIf(p.body.opKey);
      setPending(readPending());
      toast({ tone: 'success', title: '已换好，各处下次刷新时用上' });
    } catch (e) {
      // 第一次提交就被明确拒绝（别人先换过、版本不对……）：不会生效，清掉本机记录；重提被拒的留着（Codex 审查）
      if (e instanceof ApiError && !retry) {
        clearPendingIf(p.body.opKey);
        setPending(readPending());
      }
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['design'] });
    }
  };
  const assign = (slot: DesignSlot, from: number | null, to: number | null, reason = '') => {
    if (!store) {
      toast({ tone: 'error', title: '还没取到当前门店，稍后再试' });
      return;
    }
    return send({ slot, storeName: store.name, body: { versionId: to, fromVersionId: from, opKey: uuid(), reason, storeId: store.id } });
  };
  /** 这一笔是不是在别的门店发起的：是的话查回、重提、作废都不在这里做，切回那家店再处理（原记录留着） */
  const elsewhere = !!pending && !!store && pending.body.storeId !== store.id;
  const clear = (opKey: string) => {
    clearPendingIf(opKey);
    setPending(readPending());
    void qc.invalidateQueries({ queryKey: ['design'] });
  };
  /** 查回（只读）：换上了的清掉记录；查不到不等于没生效，只能原样重提或确认作废 */
  const lookup = async () => {
    if (!pending || elsewhere || stale(pending)) return;
    const key = pending.body.opKey;
    setBusy(true);
    try {
      const r = await api.get<{ found: boolean; abandoned: boolean }>(`/api/design/ops/${key}`);
      if (r.found) {
        clear(key);
        toast({ tone: 'success', title: '已查回：这一笔已经换好了' });
      } else if (r.abandoned) {
        clear(key);
        toast({ tone: 'info', title: '这一笔已经确认作废，没有换' });
      } else toast({ tone: 'info', title: '还查不到这一笔', body: '查不到不等于没生效：可以原样重提，或确认作废后重新操作' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  /** 确认作废：服务端在用途锁里登记，之后原请求晚到也不换；已经换了的给结果 */
  const abandon = async () => {
    if (!pending || elsewhere || stale(pending)) return;
    const key = pending.body.opKey;
    setBusy(true);
    try {
      const r = await api.post<{ found: boolean; abandoned: boolean }>(`/api/design/ops/${key}/abandon`, { slot: pending.slot, storeId: pending.body.storeId });
      clear(key);
      toast({ tone: r.found ? 'success' : 'info', title: r.found ? '这一笔其实已经换好了' : '已确认作废：原来那一笔不会再换，可以重新操作' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return { assign, pending, elsewhere, resend: () => pending && !elsewhere && send(pending, true), lookup, abandon, busy };
}

function SlotsPane() {
  const q = useQuery({ queryKey: keys.slots, queryFn: () => api.get<DesignSlotState[]>('/api/design/slots') });
  const { assign, pending, elsewhere, resend, lookup, abandon, busy } = useAssign();
  const [picking, setPicking] = useState<DesignSlotState | null>(null);
  const can = useCan();
  // 换用途马上改到门店看得到的地方：要发布权限（与 UI 工作台的发布一样），只有编辑权限的只能看
  const canSwitch = can('studio.publish') || can('settings.manage');
  if (q.isPending) return <Skeleton className="h-64" />;
  if (q.error) return <LoadFailed title="没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  return (
    <div className="space-y-4" data-testid="design-slots">
      {pending && elsewhere && (
        <Notice tone="warning" title={`「${pending.storeName}」有一次切换没收到结果`} data-testid="design-assign-elsewhere">
          这一笔是在「{pending.storeName}」发起的：切回那家店，再查回、原样重提或确认作废；在这家店不能处理，也先不能换别的。
        </Notice>
      )}
      {pending && !elsewhere && (
        <Notice
          tone="warning"
          title="上一次切换没收到结果"
          data-testid="design-assign-pending"
          action={
            <span className="flex flex-wrap gap-2">
              <Button size="sm" loading={busy} onClick={() => void lookup()} data-testid="design-assign-lookup">
                查回
              </Button>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void resend()} data-testid="design-assign-resend">
                原样再提交一次
              </Button>
              <Button size="sm" variant="ghost" loading={busy} onClick={() => void abandon()} data-testid="design-assign-abandon">
                确认作废
              </Button>
            </span>
          }
        >
          <span data-testid="design-assign-op" data-op={pending.body.opKey}>
            同一个操作编号再提交不会换两次；已经换好的会直接显示结果。不要了就「确认作废」，之后原来那一笔晚到也不会换。
          </span>
        </Notice>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {q.data.map((s) => {
          const Icon = KIND_ICON[s.kind];
          const previous = s.history.find((h, i) => i > 0 && h.versionId !== s.current?.versionId);
          return (
            <Card key={s.slot} className="overflow-hidden" data-testid={`design-slot-${s.slot}`}>
              <div className="flex aspect-[16/7] items-center justify-center bg-paper-2">
                {s.current ? <Preview versionId={s.current.versionId} kind={s.kind} mime={s.current.mime} /> : <span className="text-[13px] text-ink-4">没设：照原来的样子</span>}
              </div>
              <div className="space-y-2 p-4">
                <p className="flex items-center gap-2 text-[15px] font-bold text-ink">
                  <Icon className="size-4 text-pine" />
                  {s.label}
                </p>
                <p className="text-[12.5px] text-ink-3">{s.where}</p>
                <p className="text-[13px] text-ink-2" data-testid={`design-slot-current-${s.slot}`}>
                  {s.current ? `现在用：${s.current.assetName}（第 ${s.current.versionNo} 版）` : '现在用：不用素材'}
                  {s.changedAt && (
                    <span className="text-ink-3">
                      {' '}
                      · {s.changedByName} {formatDateTime(s.changedAt)}
                    </span>
                  )}
                </p>
                {canSwitch && s.newerVersionId && (
                  <Notice tone="info" title="这份素材有新版本">
                    <Button size="sm" loading={busy} onClick={() => void assign(s.slot, s.current!.versionId, s.newerVersionId, '换成新版')}>
                      换成新版
                    </Button>
                  </Notice>
                )}
                {!canSwitch && (
                  <p className="text-[12.5px] text-ink-3" data-testid={`design-slot-readonly-${s.slot}`}>
                    换用途要有「UI 工作台：发布」权限，请找店主
                  </p>
                )}
                <div className={cn('flex flex-wrap gap-2 pt-1', !canSwitch && 'hidden')}>
                  <Button size="sm" icon={<ArrowLeftRight className="size-4" />} onClick={() => setPicking(s)} data-testid={`design-slot-change-${s.slot}`}>
                    换
                  </Button>
                  {previous && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<RotateCcw className="size-4" />}
                      loading={busy}
                      onClick={() => void assign(s.slot, s.current?.versionId ?? null, previous.versionId, '切回上一份')}
                      data-testid={`design-slot-back-${s.slot}`}
                    >
                      切回上一份
                    </Button>
                  )}
                  {s.current && (
                    <Button size="sm" variant="ghost" loading={busy} onClick={() => void assign(s.slot, s.current!.versionId, null, '不用素材')} data-testid={`design-slot-none-${s.slot}`}>
                      不用素材
                    </Button>
                  )}
                </div>
                {s.history.length > 0 && (
                  <details className="text-[12.5px] text-ink-3">
                    <summary className="cursor-pointer">切换记录（{s.history.length}）</summary>
                    <ol className="mt-1 space-y-0.5">
                      {s.history.map((h) => (
                        <li key={h.id}>
                          {formatDateTime(h.at)} · {h.byName} · {h.versionId ? `${h.assetName}（第 ${h.versionNo} 版）` : '不用素材'}
                          {h.reason && `：${h.reason}`}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      {picking && (
        <PickDialog
          slot={picking}
          onClose={() => setPicking(null)}
          onPick={(versionId) => {
            setPicking(null);
            void assign(picking.slot, picking.current?.versionId ?? null, versionId);
          }}
        />
      )}
    </div>
  );
}

function PickDialog({ slot, onClose, onPick }: { slot: DesignSlotState; onClose: () => void; onPick: (versionId: number) => void }) {
  const [search, setSearch] = useState('');
  const q = useAssetList(slot.kind, false, search.trim());
  return (
    <Dialog open onClose={onClose} title={`「${slot.label}」换成哪一份`} width="max-w-3xl">
      <Input className="mb-3" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="按名字或标签搜" aria-label="搜素材" data-testid="design-pick-search" />
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : q.error ? (
        <LoadFailed title="没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : q.items.length === 0 ? (
        <p className="text-[13px] text-ink-3">{search.trim() ? '没有搜到' : `素材库里还没有${DESIGN_KIND_LABELS[slot.kind]}：先到「素材」页签上传。`}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="design-pick-list">
          {q.items.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className={cn('tap block w-full overflow-hidden rounded-lg border-2 text-left hover:border-pine', slot.current?.assetId === a.id ? 'border-pine' : 'border-line')}
                onClick={() => onPick(a.latest.id)}
                data-testid={`design-pick-${a.id}`}
              >
                <span className="flex aspect-[4/3] items-center justify-center bg-paper-2">
                  <Preview versionId={a.latest.id} kind={a.kind} mime={a.latest.mime} />
                </span>
                <span className="block truncate px-2 py-1.5 text-[13px] font-semibold">
                  {a.name} <span className="font-normal text-ink-3">第 {a.latest.versionNo} 版</span>
                </span>
              </button>
              {a.versionCount > 1 && <OlderVersions asset={a} currentVersionId={slot.current?.versionId ?? null} onPick={onPick} />}
            </li>
          ))}
        </ul>
      )}
      <MoreAssets q={q} />
    </Dialog>
  );
}

/** 素材的旧版本也能换上（Codex 审查）：版本只追加、都留着，传过的旧文件不用重传，在这里直接选 */
function OlderVersions({ asset, currentVersionId, onPick }: { asset: DesignAsset; currentVersionId: number | null; onPick: (versionId: number) => void }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['design', 'asset', asset.id], queryFn: () => api.get<DesignAssetDetail>(`/api/design/assets/${asset.id}`), enabled: open });
  if (!open) {
    return (
      <button type="button" className="tap mt-1 text-[12.5px] text-pine underline" onClick={() => setOpen(true)} data-testid={`design-pick-older-${asset.id}`}>
        选更早的版本（共 {asset.versionCount} 版）
      </button>
    );
  }
  if (q.isPending) return <Skeleton className="mt-1 h-8" />;
  if (q.error) return <LoadFailed title="没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  return (
    <ul className="mt-1 space-y-1 text-[12.5px]">
      {q.data.versions
        .filter((v) => v.id !== asset.latest.id)
        .map((v) => (
          <li key={v.id}>
            <button
              type="button"
              className={cn('tap w-full rounded border px-2 py-1 text-left hover:border-pine', currentVersionId === v.id ? 'border-pine' : 'border-line')}
              onClick={() => onPick(v.id)}
              data-testid={`design-pick-version-${v.id}`}
            >
              第 {v.versionNo} 版 <span className="text-ink-3">· {formatDateTime(v.createdAt)}</span>
            </button>
          </li>
        ))}
    </ul>
  );
}

// ───────────────────────── 素材 ─────────────────────────

/** 直接传文件内容（视频几十 MB，不走 Base64）；同一个文件重复传不会多出一份，所以出错了可以放心再传 */
async function uploadFile(kind: DesignAssetKind, file: File, opts: { assetId?: number; note?: string }) {
  const params = new URLSearchParams({ kind, name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) });
  if (opts.assetId) params.set('assetId', String(opts.assetId));
  if (opts.note) params.set('note', opts.note);
  const res = await fetch(`/api/design/upload?${params}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | DesignAssetDetail | null;
  if (!res.ok) throw new Error(body && 'error' in body && body.error ? body.error.message : `上传没成功（${res.status}），可以再传一次（同一个文件不会重复）`);
  return body as DesignAssetDetail;
}

function AssetsPane() {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<DesignAssetKind>('image');
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [license, setLicense] = useState('');
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const q = useAssetList(kind, archived, search.trim());
  const send = async (files: FileList | File[]) => {
    if (kind === 'font' && !license.trim()) {
      toast({ tone: 'error', title: '字体请先写授权说明（哪家的、授权范围）' });
      return;
    }
    setUploading(true);
    try {
      for (const f of Array.from(files)) await uploadFile(kind, f, { note: kind === 'font' ? license.trim() : undefined });
      toast({ tone: 'success', title: '已上传' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setUploading(false);
      void qc.invalidateQueries({ queryKey: ['design'] });
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) void send(e.dataTransfer.files);
  };
  return (
    <div className="space-y-4" data-testid="design-assets">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented ariaLabel="种类" value={kind} onChange={(v) => setKind(v)} options={(['image', 'video', 'font'] as const).map((k) => ({ value: k, label: DESIGN_KIND_LABELS[k] }))} />
        <Segmented
          ariaLabel="在用或归档"
          value={archived ? 'archived' : 'live'}
          onChange={(v) => setArchived(v === 'archived')}
          options={[
            { value: 'live', label: '在库' },
            { value: 'archived', label: '已归档' },
          ]}
        />
        <Input className="w-56" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="按名字或标签搜" aria-label="搜素材" data-testid="design-assets-search" />
      </div>
      <div
        className={cn('rounded-xl border-2 border-dashed p-5 text-center transition-colors', drag ? 'border-pine bg-pine-tint/40' : 'border-line-strong bg-card')}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        data-testid="design-dropzone"
      >
        <p className="text-[13.5px] text-ink-2">
          把{DESIGN_KIND_LABELS[kind]}拖到这里，或
          <Button size="sm" className="mx-2" icon={<Upload className="size-4" />} loading={uploading} onClick={() => input.current?.click()} data-testid="design-upload">
            选文件上传
          </Button>
        </p>
        <p className="mt-1 text-[12px] text-ink-3">
          {DESIGN_LIMITS[kind].formats}，每个最大 {mb(DESIGN_LIMITS[kind].maxBytes)}；同一个文件重复传不会多出一份
        </p>
        {kind === 'font' && (
          <div className="mx-auto mt-3 max-w-md text-left">
            <Field label="授权说明（必填）" htmlFor="design-license" hint="哪家的字体、授权范围；商业字体没有授权不要上传，试用版会被拒收">
              <Input id="design-license" value={license} onChange={(e) => setLicense(e.target.value)} placeholder="例如：Dinamo ABC Arizona Flare，网页授权 1 个域名" />
            </Field>
          </div>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={ACCEPT[kind]}
          onChange={(e) => {
            if (e.target.files?.length) void send(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.error ? (
        <LoadFailed title="没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : q.items.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-ink-3">{search.trim() ? '没有搜到' : archived ? '没有归档的' : `还没有${DESIGN_KIND_LABELS[kind]}`}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" data-testid="design-asset-grid">
          {q.items.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="tap mo-lift block w-full overflow-hidden rounded-xl border border-line bg-card text-left shadow-card hover:border-pine/50"
                onClick={() => setOpen(a.id)}
                data-testid={`design-asset-${a.id}`}
              >
                <span className="flex aspect-[4/3] items-center justify-center bg-paper-2">
                  <Preview versionId={a.latest.id} kind={a.kind} mime={a.latest.mime} />
                </span>
                <span className="block space-y-0.5 px-3 py-2">
                  <span className="block truncate text-[13.5px] font-bold text-ink">{a.name}</span>
                  <span className="flex flex-wrap items-center gap-1 text-[12px] text-ink-3">
                    第 {a.latest.versionNo} 版 · {mb(a.latest.sizeBytes)}
                    {a.latest.width && a.latest.height ? ` · ${a.latest.width}×${a.latest.height}` : ''}
                    {a.usedBy.length > 0 && <Badge tone="pine">在用</Badge>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <MoreAssets q={q} />
      {open !== null && <AssetDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

interface MetaForm {
  name: string;
  tags: string;
  note: string;
  /** 开始改时这份素材的修改时间 */
  base: string;
}

function AssetDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['design', 'asset', id], queryFn: () => api.get<DesignAssetDetail>(`/api/design/assets/${id}`) });
  /** 正在改的内容，连同开始改时看到的修改时间（base，Codex 审查）：后台刷新拿到别人的新修改时间也不换掉它，保存时拿 base 去核对，别人改过就拒绝 */
  const [form, setForm] = useState<MetaForm | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const a = q.data;
  const f = form ?? (a ? { name: a.name, tags: a.tags.join('，'), note: a.note, base: a.updatedAt } : null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['design'] });
  // 归档 / 恢复带页面看到的修改时间（服务端对不上拒绝 ASSET_CHANGED）：没成或结果不确定时查回这份素材——
  // 已经是想要的样子就算成了（原请求生效过），不是就照现在的样子显示、再选；原请求晚到也不会盖掉之后的改动
  const archive = async (asset: DesignAssetDetail, target: boolean) => {
    const ok = target ? '已归档' : '已恢复';
    setBusy(true);
    try {
      await api.post(`/api/design/assets/${asset.id}/archive`, { archived: target, expectedUpdatedAt: asset.updatedAt });
      toast({ tone: 'success', title: ok });
    } catch (e) {
      const now = await q.refetch().catch(() => null);
      if (now?.data && now.data.archived === target) toast({ tone: 'success', title: ok });
      else if (now?.data) toast({ tone: 'error', title: errorMessage(e), body: '已按现在的样子刷新，看过再操作' });
      else toast({ tone: 'error', title: errorMessage(e), body: '查不到现在的样子：稍后刷新看一下是否已生效，再决定要不要重做' });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  // 改名字、标签、说明带开始改时看到的修改时间（Codex 审查）：没成或结果不确定时查回——已经是填的样子就算成了；
  // 别人在这之后改过（ASSET_CHANGED）：丢掉这边的草稿、显示别人改后的样子，看过再改；
  // 结果不确定、也查不出已保存：草稿与原来的修改时间都留着，原样再点保存（同一个修改时间最多生效一次）
  const saveMeta = async (asset: DesignAssetDetail, form: MetaForm) => {
    const body = {
      name: form.name.trim(),
      tags: form.tags
        .split(/[,，、\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 10),
      note: form.note.trim(),
    };
    setBusy(true);
    try {
      await api.put(`/api/design/assets/${asset.id}`, { ...body, expectedUpdatedAt: form.base });
      toast({ tone: 'success', title: '已保存' });
      setForm(null);
    } catch (e) {
      const now = (await q.refetch().catch(() => null))?.data;
      if (now && now.name === body.name && now.note === body.note && now.tags.join('\n') === body.tags.join('\n')) {
        toast({ tone: 'success', title: '已保存' });
        setForm(null);
      } else if (e instanceof ApiError && e.code === 'ASSET_CHANGED') {
        setForm(null);
        toast({ tone: 'error', title: '别人刚改过这份素材', body: '已换成别人改后的样子，看过再改；你填的没有保存' });
      } else if (now) toast({ tone: 'error', title: errorMessage(e), body: '还没保存上；填的内容还留着，可以原样再点保存' });
      else toast({ tone: 'error', title: errorMessage(e), body: '查不到现在的样子：稍后再看是否已保存，再决定要不要重做' });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ tone: 'success', title: ok });
      setForm(null);
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return (
    <Dialog open onClose={onClose} title={a?.name ?? '素材'} width="max-w-3xl">
      {q.error && !a ? (
        <LoadFailed title="素材详情没有取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : q.isPending || !a || !f ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="space-y-4" data-testid="design-asset-dialog">
          <div className="flex aspect-[16/7] items-center justify-center overflow-hidden rounded-lg bg-paper-2">
            <Preview versionId={a.latest.id} kind={a.kind} mime={a.latest.mime} />
          </div>
          {a.usedBy.length > 0 && (
            <Notice tone="info" title={`正在用：${a.usedBy.map((u) => u.slot).join('、')}`}>
              在用的素材不能归档；要换在「用途」页签里换。
            </Notice>
          )}
          {/* 保存中不能再改（Codex 审查）：保存成功会清掉草稿，保存中途改的会被丢 */}
          <fieldset disabled={busy} className="grid min-w-0 gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="名字" htmlFor="design-name">
                <Input id="design-name" value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} />
              </Field>
              <Field label="标签" htmlFor="design-tags" hint="用逗号隔开，最多 10 个">
                <Input id="design-tags" value={f.tags} onChange={(e) => setForm({ ...f, tags: e.target.value })} />
              </Field>
            </div>
            <Field label={a.kind === 'font' ? '授权说明' : '说明'} htmlFor="design-note">
              <Textarea id="design-note" rows={2} value={f.note} onChange={(e) => setForm({ ...f, note: e.target.value })} />
            </Field>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy} disabled={!form} onClick={() => void saveMeta(a, f)}>
              保存
            </Button>
            {!a.archived && (
              <Button
                icon={<Upload className="size-4" />}
                loading={busy}
                disabled={!!form}
                title={form ? '名字、标签、说明改了还没保存：先保存或关掉重开，再传新版（传新版会让没保存的改动作废）' : undefined}
                onClick={() => input.current?.click()}
                data-testid="design-new-version"
              >
                传新版（编号不变）
              </Button>
            )}
            {form && (
              <span className="self-center text-[12.5px] text-ink-3" data-testid="design-meta-dirty">
                名字、标签、说明改了还没保存：先保存，再{a.archived ? '恢复' : '传新版或归档'}
              </span>
            )}
            {/* 归档 / 恢复会改素材的修改时间：有没保存的改动时不让点（Codex 审查），否则之后保存一定撞 ASSET_CHANGED、草稿被清掉 */}
            <Button
              variant="ghost"
              icon={a.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              loading={busy}
              disabled={!!form}
              title={form ? '名字、标签、说明改了还没保存：先保存或关掉重开' : undefined}
              onClick={() => void archive(a, !a.archived)}
            >
              {a.archived ? '恢复' : '归档'}
            </Button>
            <a className="tap relative inline-flex h-9 items-center rounded-md px-3 text-[13px] font-semibold text-pine hover:underline" href={designFileUrl(a.latest.id)} download={a.name}>
              下载这一版
            </a>
            <input
              ref={input}
              type="file"
              hidden
              accept={ACCEPT[a.kind]}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void run(() => uploadFile(a.kind, file, { assetId: a.id }), '已加新版');
              }}
            />
          </div>
          <div>
            <p className="mb-1 text-[12.5px] font-bold text-ink-3">版本（新的在前）</p>
            <ol className="divide-y divide-line rounded-lg border border-line text-[12.5px]">
              {a.versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-x-3 px-3 py-2">
                  <span className="font-semibold text-ink">第 {v.versionNo} 版</span>
                  <span className="text-ink-3">{v.mime}</span>
                  <span className="text-ink-3">{mb(v.sizeBytes)}</span>
                  {v.width && v.height && <span className="text-ink-3">{`${v.width}×${v.height}`}</span>}
                  {v.fontFamily && <span className="text-ink-3">字族：{v.fontFamily}</span>}
                  <span className="ml-auto text-ink-3">
                    {v.createdByName} · {formatDateTime(v.createdAt)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Dialog>
  );
}
