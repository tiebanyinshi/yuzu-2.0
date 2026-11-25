// OA-14 员工端「办公 → 消息」（docs/OA.md 第 17 节）：会话列表与聊天。
//   · 会话列表：按最后一条消息倒序、未读数、「有人@我」；搜索会话名、成员、消息文字；发起单聊、建群。
//     每 3 秒问一次统一的同步接口（OA-15），未读、最新一条或撤回变了才重取列表。
//   · 已读回执（OA-15，第 18 节）：自己发的消息下面写单聊「已读 / 未读」、群聊「N 人已读 / 全部已读」，点开看谁读了谁没读。
//   · 聊天：先取最近 30 条，「查看更早的消息」往上翻；每 3 秒取新消息与最近的撤回，看到了上报读到哪一条。
//     发文本（含表情）、图片、文件；群聊里输入 @ 在输入框上方列出成员（与「所有人」）；自己 2 分钟内的消息能撤回。
//   · 发送带操作编号，先记在本机（存不下就不发）：没收到结果的标「没发出去」，「重发」用原编号（服务端收到过的返回原来那一条），
//     「不发了」只去掉本机这一条（服务端其实收到了的，下次取消息照常出现，OA17）。

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, AtSign, FileText, ImagePlus, Megaphone, MessageCirclePlus, Paperclip, Search, SendHorizontal, Settings2, Smile, Users } from 'lucide-react';
import {
  IM_GROUP_MAX,
  IM_GROUP_MIN,
  IM_GROUP_NAME_MAX,
  IM_LIST_POLL_MS,
  IM_POLL_MS,
  IM_REVOKE_MINUTES,
  IM_TEXT_MAX,
  type ImConversationDetail,
  type ImConversationList,
  type ImMessage,
  type ImMessagePage,
  type ImPollResult,
  type ImRead,
  type ImSent,
  type ImSync,
  readersOf,
} from '@shared/oa-im';
import type { ApprovalPerson } from '@shared/oa-approval';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useLivePoll } from '../../lib/livePoll';
import { useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Skeleton, Textarea } from '../../components/ui';
import { uploadFile } from './oaImage';
import { GroupSettingsDialog } from './ImGroupSettings';
import { fetchNotificationUnread, IM_SYNC_KEY, MessagesTabBar, NOTIFICATION_UNREAD_KEY } from './MessagesBar';

const EMOJI = ['😀', '😂', '😊', '😍', '🤔', '😅', '😭', '😡', '👍', '👌', '🙏', '👏', '💪', '🎉', '❤️', '🌹', '☕', '🍵', '✅', '❌', '⏰', '📌', '🔥', '🙂'];
const LIST_KEY = ['oa', 'im', 'list'] as const;

export function ImPages() {
  const { pathname } = useLocation();
  const m = pathname.match(/^\/oa\/im\/(\d+)/);
  // 按会话编号给 key：换会话就是新的一页，游标、已读位置、在途的上报都不带到别的会话（Codex 审查 ce07d7e）
  return m ? <ImChatPage key={m[1]} id={Number(m[1])} /> : <ImListPage />;
}

const timeText = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === today.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

function ImListPage() {
  const qc = useQueryClient();
  const session = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<'direct' | 'group' | null>(null);
  const list = useQuery({ queryKey: [...LIST_KEY, q], queryFn: () => api.get<ImConversationList>(`/api/oa/im/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  // 统一的同步接口：未读合计或最新一条消息变了才重取列表（不变的时候每次只是一行小查询）
  const synced = useRef<string | null>(null);
  useLivePoll(
    async (isLive) => {
      const started = Date.now();
      const r = await api.get<ImSync>('/api/oa/im/sync');
      if (!isLive()) return;
      qc.setQueryData(IM_SYNC_KEY, r);
      const sig = `${r.unread}:${r.lastMessageId}:${r.revokedAt ?? ''}`;
      // 第一次：列表可能是 5 秒内的旧缓存（staleTime），不是这次同步之后取的就重取一遍（Codex 审查 5c0dc60）
      const fresh = (qc.getQueryState([...LIST_KEY, q])?.dataUpdatedAt ?? 0) >= started;
      if (synced.current === null ? !fresh : synced.current !== sig) await qc.invalidateQueries({ queryKey: LIST_KEY });
      synced.current = sig;
    },
    [qc],
    { intervalMs: IM_LIST_POLL_MS },
  );
  const d = list.data;
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title="消息" subtitle="同事之间单聊、群聊；图片与文件只有会话里的人看得到" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7">
        <MessagesTabBar active="im" />
        <ErpPendingPanel types={['oa_im_group']} filter={(op) => op.staffId === session.staff.id} className="space-y-2" onFound={() => void qc.invalidateQueries({ queryKey: LIST_KEY })} />
        <Card className="p-3.5 md:p-5" data-testid="im-list">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
              <Input value={q} onChange={(e) => setQ(e.target.value.slice(0, 30))} placeholder="搜群名、同事、聊天内容" className="pl-9" aria-label="搜索会话" data-testid="im-search" />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
              <Button variant="secondary" icon={<MessageCirclePlus className="size-4" />} onClick={() => setDialog('direct')} data-testid="im-new-direct">
                发起单聊
              </Button>
              <Button variant="secondary" icon={<Users className="size-4" />} onClick={() => setDialog('group')} data-testid="im-new-group">
                建群
              </Button>
            </div>
          </div>
          {list.isPending ? (
            <Skeleton className="h-60" />
          ) : list.isError && !d ? (
            <LoadFailed title="会话没有取回来" onRetry={() => list.refetch()} retrying={list.isFetching} />
          ) : d!.items.length === 0 ? (
            <EmptyState title={q ? '没有搜到' : '还没有会话'} description={q ? undefined : '点「发起单聊」找同事，或者「建群」拉几个人一起聊。'} />
          ) : (
            <ul className="divide-y divide-line">
              {d!.items.map((c) => (
                <li key={c.id}>
                  <Link to={`/oa/im/${c.id}`} className="tap relative flex items-center gap-3 py-3" data-testid={`im-conv-${c.id}`}>
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-pine-tint font-bold text-pine">
                      {c.kind === 'group' ? <Users className="size-5" /> : c.title.slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate font-semibold text-ink">{c.title}</span>
                        {c.kind === 'group' && <span className="num text-[12px] text-ink-3">{c.memberCount} 人</span>}
                        {c.dissolved && <Badge>已解散</Badge>}
                        <span className="num ml-auto shrink-0 text-[12px] text-ink-3">{timeText(c.lastMessageAt)}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        {c.mentioned && <span className="shrink-0 text-[13px] font-semibold text-clay">[有人@我]</span>}
                        <span className="truncate text-[13px] text-ink-3">{c.preview || ' '}</span>
                        {c.unread > 0 && (
                          <span className="num ml-auto shrink-0 rounded-full bg-clay px-2 text-[12px] font-bold text-white" data-testid={`im-unread-${c.id}`}>
                            {c.unread > 99 ? '99+' : c.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <NewChatDialog
        mode={dialog}
        onClose={() => setDialog(null)}
        onCreated={(id) => {
          setDialog(null);
          void qc.invalidateQueries({ queryKey: LIST_KEY });
          void navigate(`/oa/im/${id}`);
        }}
      />
    </>
  );
}

/** 发起单聊（选一位）/ 建群（群名 + 勾选成员） */
function NewChatDialog({ mode, onClose, onCreated }: { mode: 'direct' | 'group' | null; onClose: () => void; onCreated: (id: number) => void }) {
  const session = useSession();
  const toast = useToast();
  const me = session.staff.id;
  const people = useQuery({ queryKey: ['oa', 'approval-people'], queryFn: () => api.get<ApprovalPerson[]>('/api/oa/approval/people'), enabled: mode !== null });
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 上一次建群结果待确认：先在会话列表上方查回、原样重提或作废，确认前不再建
  const pendingGroup = useErpRecorded(['oa_im_group']).filter((op) => op.staffId === me);
  useEffect(() => {
    if (mode) {
      setQ('');
      setName('');
      setPicked([]);
      setError('');
    }
  }, [mode]);
  const shown = (people.data ?? []).filter((p) => p.id !== me && (!q || p.name.includes(q) || p.department.includes(q)));
  const start = async (staffId: number) => {
    setBusy(true);
    try {
      onCreated((await api.post<{ id: number }>('/api/oa/im/direct', { staffId })).id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (pendingGroup.length) {
      setError('上一次建群结果待确认：请先在会话列表上方查回、按原内容重新提交或作废');
      return;
    }
    setBusy(true);
    setError('');
    // 建群带操作编号，先记在本机（存不下就不发）；没收到结果的在会话列表上方查回、原样重提或确认作废
    const clientKey = uuid();
    try {
      const r = await sendErpOp<{ id: number }>({
        key: clientKey,
        type: 'oa_im_group',
        url: '/api/oa/im/groups',
        body: { clientKey, name: name.trim(), memberIds: picked },
        summary: `建群「${name.trim()}」（${picked.length + 1} 人）`,
        staffName: session.staff.displayName,
        staffId: me,
      });
      onCreated(r.id);
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '建群结果待确认', body: '已记在本机：请在会话列表上方查回、按原内容重新提交或作废，确认前不要再建一个。' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={mode !== null}
      onClose={onClose}
      title={mode === 'group' ? '建群' : '发起单聊'}
      description={mode === 'group' ? `连自己至少 ${IM_GROUP_MIN} 人、最多 ${IM_GROUP_MAX} 人；建群的人是群主` : '点一位同事就开始聊；以前聊过的打开原来的会话'}
      footer={
        mode === 'group' ? (
          <>
            <Button variant="secondary" size="lg" onClick={onClose}>
              取消
            </Button>
            <Button size="lg" loading={busy} disabled={!name.trim() || picked.length + 1 < IM_GROUP_MIN} onClick={() => void create()} data-testid="im-group-create">
              建群（{picked.length + 1} 人）
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {mode === 'group' && (
          <Field label="群名">
            <Input value={name} maxLength={IM_GROUP_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="例如 前厅早班" data-testid="im-group-name" />
          </Field>
        )}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按姓名、部门找" aria-label="找同事" data-testid="im-people-search" />
        {error && (
          <p className="text-[13px] text-clay" role="alert">
            {error}
          </p>
        )}
        {people.isPending ? (
          <Skeleton className="h-40" />
        ) : people.isError && !people.data ? (
          <LoadFailed title="同事名单没有取回来" onRetry={() => people.refetch()} retrying={people.isFetching} />
        ) : (
          <ul className="max-h-[50dvh] divide-y divide-line overflow-y-auto" data-testid="im-people">
            {shown.map((p) => (
              <li key={p.id}>
                {mode === 'group' ? (
                  <label className="tap relative flex items-center gap-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={picked.includes(p.id)}
                      onChange={(e) => setPicked((xs) => (e.target.checked ? [...xs, p.id] : xs.filter((x) => x !== p.id)))}
                      className="size-4 accent-pine"
                      data-testid={`im-pick-${p.id}`}
                    />
                    <span className="font-semibold text-ink">{p.name}</span>
                    <span className="text-[13px] text-ink-3">{p.department}</span>
                  </label>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void start(p.id)} className="tap relative flex w-full items-center gap-3 py-2.5 text-left" data-testid={`im-person-${p.id}`}>
                    <span className="font-semibold text-ink">{p.name}</span>
                    <span className="text-[13px] text-ink-3">{p.department}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** 本机还没确认发出的消息（存在本机，存不下就不发） */
type Pending = { clientKey: string; kind: 'text' | 'image' | 'file'; body: string; attachmentId: number | null; fileName: string; mentions: number[]; mentionAll: boolean; failed: boolean };
const pendingKey = (conv: number, staff: number) => `yuzu.im.pending.${staff}.${conv}`;
function loadPending(conv: number, staff: number): Pending[] {
  try {
    return (JSON.parse(localStorage.getItem(pendingKey(conv, staff)) ?? '[]') as Pending[]).map((p) => ({ ...p, failed: true }));
  } catch {
    return [];
  }
}
function savePending(conv: number, staff: number, list: Pending[]): boolean {
  try {
    const k = pendingKey(conv, staff);
    if (list.length) localStorage.setItem(k, JSON.stringify(list));
    else localStorage.removeItem(k);
    return (localStorage.getItem(k) ?? '[]') === (list.length ? JSON.stringify(list) : '[]');
  } catch {
    return false;
  }
}

function ImChatPage({ id }: { id: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const me = session.staff.id;
  const detail = useQuery({ queryKey: ['oa', 'im', 'conv', id], queryFn: () => api.get<ImConversationDetail>(`/api/oa/im/conversations/${id}`) });
  const [messages, setMessages] = useState<ImMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [pending, setPendingState] = useState<Pending[]>([]);
  // 待发队列的最新值（上传完成等晚到的回调也按最新的改，不用回调开始那一刻的快照，Codex 审查 15f56d2）
  const pendingRef = useRef<Pending[]>([]);
  /** 改待发队列并记到本机；记不下返回 false（不改） */
  const updatePending = (fn: (xs: Pending[]) => Pending[], persist = true): boolean => {
    const next = fn(pendingRef.current);
    if (persist && !savePending(id, me, next)) return false;
    pendingRef.current = next;
    setPendingState(next);
    return true;
  };
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<{ id: number; name: string }[]>([]);
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [settings, setSettings] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const navigate = useNavigate();
  const leave = async () => {
    setLeaveBusy(true);
    try {
      await api.post(`/api/oa/im/conversations/${id}/leave`, {});
      void qc.invalidateQueries({ queryKey: LIST_KEY });
      void navigate('/oa/im', { replace: true });
    } catch (e) {
      toast({ tone: 'error', title: '没有退出', body: errorMessage(e) });
    } finally {
      setLeaveBusy(false);
      setLeaving(false);
    }
  };
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  // 同步游标：只由首次取历史与连续的「取新消息」推进（自己发出去的那条不推进它，
  // 不然别人刚好排在前面的那条就跳过了，Codex 审查 accf8fb）；上报已读也只报到这里
  const [cursor, setCursor] = useState(0);
  // 已读回执：其他成员各读到哪一条（取历史、取新消息时一起带回来）
  const [reads, setReads] = useState<ImRead[]>([]);
  const [receiptOf, setReceiptOf] = useState<number | null>(null);
  const lastShown = messages?.at(-1)?.id ?? 0;
  // 服务端上次同步的时间：撤回从这里续传（页面在后台、断网好几分钟回来也补得上）
  const since = useRef<string | null>(null);
  // 已经成功上报的已读位置（只在成功以后记，失败的下次取新消息时再报）
  const acked = useRef(0);
  const reporting = useRef(false);

  const load = async () => {
    setLoadError('');
    try {
      const page = await api.get<ImMessagePage>(`/api/oa/im/conversations/${id}/messages`);
      setMessages(page.messages);
      setHasMore(page.hasMore);
      setCursor(page.messages.at(-1)?.id ?? 0);
      setReads(page.reads);
      since.current = page.syncedAt;
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  };
  useEffect(() => {
    setMessages(null);
    setCursor(0);
    acked.current = 0;
    since.current = null;
    void load();
    const restored = me ? loadPending(id, me) : [];
    pendingRef.current = restored;
    setPendingState(restored);
  }, [id, me]);

  // 每 3 秒取新消息与最近的撤回
  useLivePoll(
    async (isLive) => {
      if (messages === null) return;
      const r = await api.get<ImPollResult>(`/api/oa/im/conversations/${id}/poll?after=${cursor}${since.current ? `&since=${encodeURIComponent(since.current)}` : ''}`);
      if (!isLive()) return;
      since.current = r.syncedAt;
      setReads((old) => (JSON.stringify(old) === JSON.stringify(r.reads) ? old : r.reads));
      if (r.messages.length || r.revoked.length) {
        setMessages((xs) => {
          // 同一编号以服务端这次给的为准（自己发的那条已经显示、后来在别处撤回了，这里要跟着变，Codex 审查 ce07d7e）
          const fresh = new Map(r.messages.map((x) => [x.id, x]));
          const merged = [...(xs ?? []).filter((x) => !fresh.has(x.id)), ...r.messages].sort((a, b) => a.id - b.id);
          return merged.map((x) => (r.revoked.includes(x.id) && !x.revoked ? { ...x, revoked: true, body: '', attachment: null } : x));
        });
      }
      if (r.messages.length) setCursor((c) => Math.max(c, r.messages.at(-1)!.id));
      // 系统提示（拉人、踢人、改群名、公告、转让、解散）：群的现状变了，重取一次（OA-16）
      if (r.messages.some((x) => x.kind === 'system')) void qc.invalidateQueries({ queryKey: ['oa', 'im', 'conv', id] });
      else void reportRead(cursor);
    },
    [id, cursor, messages === null],
    { intervalMs: IM_POLL_MS },
  );

  // 看到了：上报读到哪一条；新消息来了滚到底
  const reportRead = async (upTo: number) => {
    if (!upTo || upTo <= acked.current || reporting.current || document.hidden) return;
    reporting.current = true;
    try {
      await api.post(`/api/oa/im/conversations/${id}/read`, { upTo });
      acked.current = Math.max(acked.current, upTo);
      void qc.invalidateQueries({ queryKey: LIST_KEY });
      void api
        .get<ImSync>('/api/oa/im/sync')
        .then((sync) => qc.setQueryData(IM_SYNC_KEY, sync))
        .catch(() => undefined);
      void fetchNotificationUnread()
        .then((counts) => qc.setQueryData(NOTIFICATION_UNREAD_KEY, counts))
        .catch(() => undefined);
    } catch {
      // 没报上：下一次取新消息时再报（Codex 审查 accf8fb）
    } finally {
      reporting.current = false;
    }
  };
  useEffect(() => {
    void reportRead(cursor);
    // reportRead 每次渲染都是新的，只按位置变化触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cursor]);
  useEffect(() => {
    if (lastShown) bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastShown, pending.length]);

  const earlier = async () => {
    const first = messages?.[0];
    if (!first) return;
    try {
      const page = await api.get<ImMessagePage>(`/api/oa/im/conversations/${id}/messages?before=${first.id}`);
      setMessages((xs) => [...page.messages, ...(xs ?? [])]);
      setHasMore(page.hasMore);
    } catch (e) {
      toast({ tone: 'error', title: '更早的消息没有取回来', body: errorMessage(e) });
    }
  };

  const deliver = async (p: Pending) => {
    try {
      const r = await api.post<ImSent>(`/api/oa/im/conversations/${id}/messages`, {
        clientKey: p.clientKey,
        kind: p.kind,
        body: p.body,
        attachmentId: p.attachmentId,
        mentions: p.mentions,
        mentionAll: p.mentionAll,
      });
      updatePending((xs) => xs.filter((x) => x.clientKey !== p.clientKey));
      setMessages((xs) => (xs && !xs.some((x) => x.id === r.message.id) ? [...xs, r.message].sort((a, b) => a.id - b.id) : xs));
    } catch (e) {
      updatePending((xs) => xs.map((x) => (x.clientKey === p.clientKey ? { ...x, failed: true } : x)), false);
      toast({ tone: 'error', title: '消息没发出去', body: `${errorMessage(e)}。可以点「重发」（不会发两遍）` });
    }
  };
  const queue = (p: Omit<Pending, 'clientKey' | 'failed'>) => {
    const item: Pending = { ...p, clientKey: uuid(), failed: false };
    // 先记在本机，存不下就不发（没收到结果时才能用原编号重发）
    if (!updatePending((xs) => [...xs, item])) {
      toast({ tone: 'error', title: '这台设备存不下待发的消息，先不发', body: '请检查浏览器是否开了无痕模式或存储已满' });
      return false;
    }
    void deliver(item);
    return true;
  };
  const sendText = () => {
    const body = text.trim();
    if (!body) return;
    // 只认正文里还在的 @（删掉了「@所有人」就不再全员提醒，Codex 审查 accf8fb）
    const used = mentions.filter((m) => body.includes(`@${m.name}`));
    const ok = queue({
      kind: 'text',
      body,
      attachmentId: null,
      fileName: '',
      mentions: used.filter((m) => m.id > 0).map((m) => m.id),
      mentionAll: used.some((m) => m.id === 0),
    });
    if (ok) {
      setText('');
      setMentions([]);
    }
  };
  const sendFile = async (file: File, kind: 'image' | 'file') => {
    setUploading(true);
    try {
      const a = await uploadFile(file);
      queue({ kind: a.isImage && kind === 'image' ? 'image' : 'file', body: '', attachmentId: a.id, fileName: a.fileName, mentions: [], mentionAll: false });
    } catch (e) {
      toast({ tone: 'error', title: '文件没有传上去', body: errorMessage(e) });
    } finally {
      setUploading(false);
    }
  };
  const revoke = async (m: ImMessage) => {
    try {
      const r = await api.post<ImMessage>(`/api/oa/im/messages/${m.id}/revoke`, {});
      setMessages((xs) => xs?.map((x) => (x.id === r.id ? r : x)) ?? xs);
    } catch (e) {
      toast({ tone: 'error', title: '撤回没成功', body: errorMessage(e) });
    }
  };

  const d = detail.data;
  // 输入 @ 时在输入框上方列出群成员（与「所有人」），按 @ 后面打的字筛
  const at = d?.kind === 'group' ? text.match(/@([^\s@]*)$/) : null;
  const candidates = useMemo(
    () => (at && d ? [{ id: 0, name: '所有人' }, ...d.members.filter((m) => m.staffId !== me).map((m) => ({ id: m.staffId, name: m.name }))].filter((m) => m.name.includes(at[1] ?? '')) : []),
    [at, d, me],
  );
  const pick = (m: { id: number; name: string }) => {
    setText((t) => `${t.replace(/@[^\s@]*$/, '')}@${m.name} `);
    setMentions((xs) => (xs.some((x) => x.id === m.id) ? xs : [...xs, m]));
  };

  return (
    <>
      <div className="max-md:hidden">
        <PageHeader dateMode="calendar" title={d?.title ?? '消息'} subtitle={d ? (d.kind === 'group' ? `群聊 · ${d.members.length} 人` : '单聊') : undefined} />
      </div>
      <div className="mx-auto w-full max-w-3xl p-2 md:p-6">
        <Card className="flex h-[calc(100dvh-9.5rem)] flex-col p-0 md:h-[calc(100dvh-11rem)]" data-testid="im-chat">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Link to="/oa/im" className="tap relative flex shrink-0 items-center gap-1 text-[14px] text-ink-2" data-testid="im-back">
              <ArrowLeft className="size-4" />
              <span className="max-sm:hidden">会话列表</span>
            </Link>
            <span className="min-w-0 truncate text-[15px] font-bold text-ink md:hidden">{d?.title ?? '消息'}</span>
            {d?.kind === 'group' && <span className="ml-auto hidden min-w-0 truncate text-[12px] text-ink-3 md:inline">{d.members.map((m) => m.name).join('、')}</span>}
            {d?.kind === 'group' && (
              <Button size="sm" variant="ghost" className="ml-auto shrink-0 md:ml-0" icon={<Settings2 className="size-4" />} onClick={() => setSettings(true)} data-testid="im-settings">
                群设置
              </Button>
            )}
          </div>
          {d?.notice && (
            <button
              type="button"
              className="tap relative flex items-start gap-2 border-b border-line bg-yuzu-tint px-3 py-2 text-left text-[13px] text-ink-2"
              onClick={() => setSettings(true)}
              data-testid="im-notice"
            >
              <Megaphone className="mt-0.5 size-4 shrink-0 text-ink-3" />
              <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap">{d.notice.text}</span>
              <span className="shrink-0 text-[12px] text-ink-3">{d.notice.byName}</span>
            </button>
          )}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" data-testid="im-messages">
            {detail.isError && !d ? (
              <LoadFailed title="会话没有取回来" onRetry={() => detail.refetch()} retrying={detail.isFetching} />
            ) : messages === null ? (
              loadError ? (
                <LoadFailed title="消息没有取回来" onRetry={() => void load()} />
              ) : (
                <Skeleton className="h-40" />
              )
            ) : (
              <>
                {hasMore && (
                  <div className="text-center">
                    <Button size="sm" variant="ghost" onClick={() => void earlier()} data-testid="im-earlier">
                      查看更早的消息
                    </Button>
                  </div>
                )}
                {messages.length === 0 && pending.length === 0 && <p className="py-10 text-center text-[13px] text-ink-3">还没有消息，打个招呼吧</p>}
                {messages.map((m) => (
                  <Bubble
                    key={m.id}
                    m={m}
                    mine={m.senderId === me}
                    group={d?.kind === 'group'}
                    me={me}
                    receipt={m.senderId === me && d ? receiptText(m.id, d, reads) : null}
                    onReceipt={() => setReceiptOf(m.id)}
                    onRevoke={() => void revoke(m)}
                  />
                ))}
                {pending.map((p) => (
                  <div key={p.clientKey} className="flex flex-col items-end gap-1" data-testid="im-pending">
                    <div className="max-w-[80%] rounded-lg bg-pine/70 px-3 py-2 text-[14px] whitespace-pre-wrap text-white">
                      {p.kind === 'text' ? p.body : `[${p.kind === 'image' ? '图片' : '文件'}] ${p.fileName}`}
                    </div>
                    <span className="flex items-center gap-2 text-[12px]">
                      {p.failed ? (
                        <>
                          <span className="text-clay">没发出去</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              updatePending((xs) => xs.map((x) => (x.clientKey === p.clientKey ? { ...x, failed: false } : x)), false);
                              void deliver(p);
                            }}
                          >
                            重发
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => updatePending((xs) => xs.filter((x) => x.clientKey !== p.clientKey))}>
                            不发了
                          </Button>
                        </>
                      ) : (
                        <span className="text-ink-3">发送中…</span>
                      )}
                    </span>
                  </div>
                ))}
                <div ref={bottom} />
              </>
            )}
          </div>
          {d?.dissolved ? (
            <p className="border-t border-line p-3 text-center text-[13px] text-ink-3" data-testid="im-dissolved">
              这个群已经解散，只能看历史消息
            </p>
          ) : (
            <div className="relative border-t border-line p-2">
              {candidates.length > 0 && (
                <ul className="absolute right-2 bottom-full left-2 mb-1 max-h-48 overflow-y-auto rounded-md border border-line bg-card shadow-card" data-testid="im-at-list">
                  {candidates.map((m) => (
                    <li key={m.id}>
                      <button type="button" onClick={() => pick(m)} className="tap relative flex w-full items-center gap-2 px-3 py-2 text-left text-[14px]" data-testid={`im-at-${m.id}`}>
                        <AtSign className="size-4 text-ink-3" />
                        {m.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {showEmoji && (
                <div className="mb-2 grid grid-cols-8 gap-1" data-testid="im-emoji">
                  {EMOJI.map((e) => (
                    <button key={e} type="button" className="tap relative rounded-md py-1 text-[20px] hover:bg-paper-2" onClick={() => setText((t) => t + e)}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
              <Textarea
                value={text}
                maxLength={IM_TEXT_MAX}
                rows={1}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    sendText();
                  }
                }}
                placeholder={d?.kind === 'group' ? '说点什么，输入 @ 提醒同事' : '说点什么'}
                className="max-h-32 min-h-10 w-full resize-none"
                aria-label="消息"
                data-testid="im-input"
              />
              <div className="mt-1 flex items-center gap-1">
                <Button size="sm" variant="ghost" icon={<Smile className="size-5" />} aria-label="表情" onClick={() => setShowEmoji((v) => !v)} />
                <Button size="sm" variant="ghost" icon={<ImagePlus className="size-5" />} aria-label="发图片" disabled={uploading} onClick={() => imageInput.current?.click()} />
                <Button size="sm" variant="ghost" icon={<Paperclip className="size-5" />} aria-label="发文件" disabled={uploading} onClick={() => fileInput.current?.click()} />

                <Button className="ml-auto" icon={<SendHorizontal className="size-4" />} disabled={!text.trim() || !me} onClick={sendText} data-testid="im-send">
                  发送
                </Button>
              </div>
              <input
                ref={imageInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                data-testid="im-image-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void sendFile(f, 'image');
                }}
              />
              <input
                ref={fileInput}
                type="file"
                hidden
                data-testid="im-file-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void sendFile(f, 'file');
                }}
              />
            </div>
          )}
        </Card>
      </div>
      <Dialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title="退出群聊"
        description="退出以后看不到这个群的消息，群里会显示你退出了；要回来请群主或管理员再拉你"
        footer={
          <>
            <Button variant="secondary" size="lg" onClick={() => setLeaving(false)}>
              取消
            </Button>
            <Button variant="danger" size="lg" loading={leaveBusy} onClick={() => void leave()} data-testid="im-leave-confirm">
              退出群聊
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-ink-2">确定退出「{d?.title}」吗？</p>
      </Dialog>
      <ReceiptDialog messageId={receiptOf} detail={d} reads={reads} onClose={() => setReceiptOf(null)} />
      {d?.kind === 'group' && (
        <GroupSettingsDialog
          open={settings}
          detail={d}
          me={me}
          onClose={() => setSettings(false)}
          onChanged={(next) => qc.setQueryData(['oa', 'im', 'conv', id], next)}
          onRefresh={() => void detail.refetch()}
          onLeave={() => {
            setSettings(false);
            setLeaving(true);
          }}
        />
      )}
    </>
  );
}

/** 自己发的一条消息下面的回执：单聊「已读 / 未读」，群聊「N 人已读 / 全部已读」（只算现在还在会话里的人） */
function receiptText(messageId: number, d: ImConversationDetail, reads: readonly ImRead[]): { text: string; done: boolean; clickable: boolean } | null {
  const { read, unread } = readersOf(messageId, d.members, reads);
  if (read.length + unread.length === 0) return null;
  if (d.kind === 'direct') return { text: unread.length ? '未读' : '已读', done: unread.length === 0, clickable: false };
  return { text: unread.length ? `${read.length} 人已读` : '全部已读', done: unread.length === 0, clickable: true };
}

function ReceiptDialog({ messageId, detail, reads, onClose }: { messageId: number | null; detail: ImConversationDetail | undefined; reads: readonly ImRead[]; onClose: () => void }) {
  const { read, unread } = messageId && detail ? readersOf(messageId, detail.members, reads) : { read: [], unread: [] };
  const list = (title: string, people: typeof read, testId: string) => (
    <div data-testid={testId}>
      <p className="mb-1 text-[13px] font-semibold text-ink-2">
        {title} <span className="num">{people.length}</span>
      </p>
      <p className="text-[14px] text-ink">{people.length ? people.map((p) => p.name).join('、') : '—'}</p>
    </div>
  );
  return (
    <Dialog open={messageId !== null} onClose={onClose} title="已读情况">
      <div className="space-y-4">
        {list('已读', read, 'im-receipt-read')}
        {list('未读', unread, 'im-receipt-unread')}
      </div>
    </Dialog>
  );
}

function Bubble({
  m,
  mine,
  group,
  me,
  receipt,
  onReceipt,
  onRevoke,
}: {
  m: ImMessage;
  mine: boolean;
  group: boolean;
  me: number;
  receipt: { text: string; done: boolean; clickable: boolean } | null;
  onReceipt: () => void;
  onRevoke: () => void;
}) {
  if (m.kind === 'system') return <p className="text-center text-[12px] text-ink-3">{m.body}</p>;
  if (m.revoked) {
    return (
      <p className="text-center text-[12px] text-ink-3" data-testid={`im-msg-${m.id}`}>
        {mine ? '你' : m.senderName}撤回了一条消息
      </p>
    );
  }
  const canRevoke = mine && Date.now() - new Date(m.createdAt).getTime() < IM_REVOKE_MINUTES * 60_000;
  const atMe = !mine && (m.mentionAll || m.mentions.includes(me));
  return (
    <div className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')} data-testid={`im-msg-${m.id}`}>
      <span className="text-[12px] text-ink-3">
        {!mine && group ? `${m.senderName} · ` : ''}
        {timeText(m.createdAt)}
        {atMe && (
          <Badge tone="clay" className="ml-1">
            @我
          </Badge>
        )}
      </span>
      <div className={cn('max-w-[80%] rounded-lg px-3 py-2 text-[14px] break-words whitespace-pre-wrap', mine ? 'bg-pine text-white' : 'bg-paper-2 text-ink')}>
        {m.kind === 'text' ? (
          m.body
        ) : m.attachment?.isImage ? (
          <a href={m.attachment.url} target="_blank" rel="noreferrer">
            <img src={m.attachment.thumbUrl ?? m.attachment.url} alt={m.attachment.fileName} className="max-h-48 rounded-md" />
          </a>
        ) : m.attachment ? (
          <a href={m.attachment.url} className="flex items-center gap-2 underline" download>
            <FileText className="size-4" />
            {m.attachment.fileName}
            <span className="num text-[12px] opacity-80">{Math.max(1, Math.round(m.attachment.sizeBytes / 1024))} KB</span>
          </a>
        ) : null}
      </div>
      {(receipt || canRevoke) && (
        <span className="flex items-center gap-1">
          {receipt &&
            (receipt.clickable ? (
              <button
                type="button"
                className={cn('tap relative px-1 text-[12px] underline-offset-2 hover:underline', receipt.done ? 'text-ink-3' : 'text-pine')}
                onClick={onReceipt}
                data-testid={`im-receipt-${m.id}`}
              >
                {receipt.text}
              </button>
            ) : (
              <span className={cn('px-1 text-[12px]', receipt.done ? 'text-ink-3' : 'text-pine')} data-testid={`im-receipt-${m.id}`}>
                {receipt.text}
              </span>
            ))}
          {canRevoke && (
            <Button size="sm" variant="ghost" onClick={onRevoke} data-testid={`im-revoke-${m.id}`}>
              撤回
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
