// OA-16 聊天页「群设置」（docs/OA.md 第 19 节）：群名、群公告、成员（群主 / 管理员 / 部门同步进来的）、拉人、踢人、
// 设 / 撤管理员、转让群主、退出、解散。按钮按 shared/oa-im 的规则显示（服务端照同一个规则核对）。
// 这些操作不带操作编号、按结果幂等（OA20）：没收到结果就刷新看现状，再决定要不要重做。

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Crown, LogOut, ShieldCheck, Trash2, UserMinus, UserPlus } from 'lucide-react';
import { IM_GROUP_MAX, IM_GROUP_NAME_MAX, IM_NOTICE_MAX, canKick, canManageGroup, type ImConversationDetail, type ImMember } from '@shared/oa-im';
import type { ApprovalPerson } from '@shared/oa-approval';
import { api, errorMessage } from '../../lib/api';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Skeleton, Textarea } from '../../components/ui';

export function GroupSettingsDialog({
  open,
  detail: d,
  me,
  onClose,
  onChanged,
  onRefresh,
  onLeave,
}: {
  open: boolean;
  detail: ImConversationDetail;
  me: number;
  onClose: () => void;
  onChanged: (d: ImConversationDetail) => void;
  onRefresh: () => void;
  onLeave: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(d.title);
  const [notice, setNotice] = useState(d.notice?.text ?? '');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (open) {
      setName(d.title);
      setNotice(d.notice?.text ?? '');
      setConfirm('');
      setAdding(false);
    }
    // 打开时取一次现状；之后别人改了群名、公告不覆盖正在改的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const manager = !d.dissolved && canManageGroup(d.myRole);
  const owner = !d.dissolved && d.myRole === 'owner';
  const mine = d.members.find((m) => m.staffId === me);
  const canLeave = d.dissolved || (d.myRole !== 'owner' && mine?.source !== 'dept');

  const run = async (key: string, url: string, body?: unknown, done?: string) => {
    setBusy(key);
    setConfirm('');
    try {
      onChanged(await api.post<ImConversationDetail>(url, body));
      if (done) toast({ tone: 'success', title: done });
      return true;
    } catch (e) {
      // 结果不确定（超时、断网）：刷新看现状再决定要不要重做；操作本身按结果幂等，重做不会做两遍
      toast({ tone: 'error', title: '没有办成', body: `${errorMessage(e)}。已刷新群的现状，请看一下再决定要不要重做` });
      onRefresh();
      return false;
    } finally {
      setBusy('');
    }
  };
  const put = async (key: string, url: string, body: unknown, done: string) => {
    setBusy(key);
    try {
      onChanged(await api.put<ImConversationDetail>(url, body));
      toast({ tone: 'success', title: done });
    } catch (e) {
      toast({ tone: 'error', title: '没有办成', body: `${errorMessage(e)}。已刷新群的现状，请看一下再决定要不要重做` });
      onRefresh();
    } finally {
      setBusy('');
    }
  };
  const base = `/api/oa/im/conversations/${d.id}`;
  const twice = (key: string, action: () => void) => (confirm === key ? action() : setConfirm(key));

  const memberActions = (m: ImMember) => {
    const out: React.ReactNode[] = [];
    if (owner && m.staffId !== me && m.role !== 'owner') {
      out.push(
        <Button
          key="role"
          size="sm"
          variant="ghost"
          icon={<ShieldCheck className="size-4" />}
          loading={busy === `role-${m.staffId}`}
          onClick={() => void put(`role-${m.staffId}`, `${base}/members/${m.staffId}/role`, { role: m.role === 'admin' ? 'member' : 'admin' }, '已改')}
          data-testid={`im-gs-role-${m.staffId}`}
        >
          {m.role === 'admin' ? '取消管理员' : '设为管理员'}
        </Button>,
        <Button
          key="transfer"
          size="sm"
          variant="ghost"
          icon={<Crown className="size-4" />}
          loading={busy === `transfer-${m.staffId}`}
          onClick={() => twice(`transfer-${m.staffId}`, () => void run(`transfer-${m.staffId}`, `${base}/transfer`, { staffId: m.staffId }, `群主已转给${m.name}`))}
          data-testid={`im-gs-transfer-${m.staffId}`}
        >
          {confirm === `transfer-${m.staffId}` ? '确认转让？' : '转让群主'}
        </Button>,
      );
    }
    if (!d.dissolved && canKick({ staffId: me, role: d.myRole }, m)) {
      out.push(
        <Button
          key="kick"
          size="sm"
          variant="ghost"
          icon={<UserMinus className="size-4" />}
          loading={busy === `kick-${m.staffId}`}
          onClick={() => twice(`kick-${m.staffId}`, () => void run(`kick-${m.staffId}`, `${base}/members/${m.staffId}/remove`, undefined, `已把${m.name}移出群聊`))}
          data-testid={`im-gs-kick-${m.staffId}`}
        >
          {confirm === `kick-${m.staffId}` ? '确认移出？' : '移出'}
        </Button>,
      );
    }
    return out;
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="群设置"
      description={d.dissolved ? '这个群已经解散，只能看历史消息' : `${d.members.length} 人${d.deptKey ? ' · 部门群（本部门的同事跟着岗位自动进出）' : ''}`}
    >
      <div className="space-y-4" data-testid="im-group-settings">
        {manager ? (
          <>
            <Field label="群名">
              <div className="flex gap-2">
                <Input value={name} maxLength={IM_GROUP_NAME_MAX} onChange={(e) => setName(e.target.value)} data-testid="im-gs-name" />
                <Button
                  variant="secondary"
                  loading={busy === 'name'}
                  disabled={!name.trim() || name.trim() === d.title}
                  onClick={() => void put('name', `${base}/name`, { name: name.trim() }, '群名已改')}
                  data-testid="im-gs-name-save"
                >
                  保存
                </Button>
              </div>
            </Field>
            <Field label="群公告" hint="显示在聊天页顶上；清空保存就是撤掉公告">
              <Textarea value={notice} maxLength={IM_NOTICE_MAX} rows={3} onChange={(e) => setNotice(e.target.value)} data-testid="im-gs-notice" />
            </Field>
            <Button
              variant="secondary"
              loading={busy === 'notice'}
              disabled={notice.trim() === (d.notice?.text ?? '')}
              onClick={() => void put('notice', `${base}/notice`, { notice: notice.trim() }, notice.trim() ? '群公告已发布' : '群公告已撤掉')}
              data-testid="im-gs-notice-save"
            >
              发布公告
            </Button>
          </>
        ) : (
          d.notice && (
            <div>
              <p className="mb-1 text-[13px] font-semibold text-ink-2">群公告</p>
              <p className="text-[14px] whitespace-pre-wrap text-ink">{d.notice.text}</p>
            </div>
          )
        )}

        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[13px] font-semibold text-ink-2">
              成员 <span className="num">{d.members.length}</span>
            </p>
            {manager && !adding && (
              <Button size="sm" variant="ghost" icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)} data-testid="im-gs-add">
                拉人
              </Button>
            )}
          </div>
          {adding && (
            <AddMembers
              exclude={d.members.map((m) => m.staffId)}
              room={IM_GROUP_MAX - d.members.length}
              busy={busy === 'add'}
              onCancel={() => setAdding(false)}
              onAdd={async (ids) => {
                if (await run('add', `${base}/members`, { staffIds: ids }, `已拉 ${ids.length} 人进群`)) setAdding(false);
              }}
            />
          )}
          <ul className="divide-y divide-line">
            {d.members.map((m) => (
              <li key={m.staffId} className="flex flex-wrap items-center gap-2 py-2" data-testid={`im-gs-member-${m.staffId}`}>
                <span className="min-w-[6em] flex-1 truncate text-[14px] text-ink">
                  {m.name}
                  {m.staffId === me && <span className="text-ink-3">（我）</span>}
                </span>
                {m.role === 'owner' && <Badge tone="pine">群主</Badge>}
                {m.role === 'admin' && <Badge tone="lake">管理员</Badge>}
                {m.source === 'dept' && <Badge>本部门</Badge>}
                {/* 手机上按钮另起一行（名字不被挤掉） */}
                {memberActions(m).length > 0 && <span className="flex basis-full justify-end gap-1 sm:basis-auto">{memberActions(m)}</span>}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          {canLeave ? (
            <Button variant="secondary" icon={<LogOut className="size-4" />} onClick={onLeave} data-testid="im-leave">
              退出群聊
            </Button>
          ) : (
            <p className="text-[13px] text-ink-3">{d.myRole === 'owner' ? '群主要先把群主转给别人才能退群' : '部门群里本部门的人不能自己退，调到别的部门会自动出群'}</p>
          )}
          {owner && (
            <Button
              variant="danger"
              className="ml-auto"
              icon={<Trash2 className="size-4" />}
              loading={busy === 'dissolve'}
              onClick={() => twice('dissolve', () => void run('dissolve', `${base}/dissolve`, undefined, '群已解散'))}
              data-testid="im-gs-dissolve"
            >
              {confirm === 'dissolve' ? '确认解散？解散后谁都不能再发消息' : '解散群聊'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** 拉人：从在职同事里勾选（已经在群里的不列） */
function AddMembers({ exclude, room, busy, onCancel, onAdd }: { exclude: number[]; room: number; busy: boolean; onCancel: () => void; onAdd: (ids: number[]) => void }) {
  const people = useQuery({ queryKey: ['oa', 'approval-people'], queryFn: () => api.get<ApprovalPerson[]>('/api/oa/approval/people') });
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const shown = (people.data ?? []).filter((p) => !exclude.includes(p.id) && (!q || p.name.includes(q) || p.department.includes(q)));
  return (
    <div className="mb-2 space-y-2 rounded-lg border border-line p-3" data-testid="im-gs-add-panel">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按姓名、部门找" aria-label="找同事" data-testid="im-gs-add-search" />
      {people.isPending ? (
        <Skeleton className="h-24" />
      ) : people.isError && !people.data ? (
        <LoadFailed title="同事名单没有取回来" onRetry={() => people.refetch()} retrying={people.isFetching} />
      ) : (
        <ul className="max-h-48 divide-y divide-line overflow-y-auto">
          {shown.map((p) => (
            <li key={p.id}>
              <label className="tap relative flex items-center gap-2 py-2 text-[14px]">
                <input
                  type="checkbox"
                  checked={picked.includes(p.id)}
                  onChange={(e) => setPicked((xs) => (e.target.checked ? [...xs, p.id] : xs.filter((x) => x !== p.id)))}
                  data-testid={`im-gs-pick-${p.id}`}
                />
                <span className="flex-1">{p.name}</span>
                <span className="text-[12px] text-ink-3">{p.department}</span>
              </label>
            </li>
          ))}
          {!shown.length && <li className="py-2 text-[13px] text-ink-3">没有可以拉的同事</li>}
        </ul>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" loading={busy} disabled={!picked.length || picked.length > room} onClick={() => onAdd(picked)} data-testid="im-gs-add-confirm">
          拉进群（{picked.length} 人）
        </Button>
        {picked.length > room && <span className="text-[12px] text-clay">一个群最多 {IM_GROUP_MAX} 人</span>}
      </div>
    </div>
  );
}
