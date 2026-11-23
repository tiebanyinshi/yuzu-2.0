// OA-16 员工端「办公 → 通讯录」（docs/OA.md 第 19 节）：部门按上下级排成树，每个部门下列本部门在职员工；搜索姓名、工号、手机号。
//   · 点一个人出资料卡（姓名、部门、岗位、工号、手机号），「发消息」打开与他的单聊。
//   · 部门旁边「部门群」：有、我在里面的直接打开；管组织架构的人与部门主管能建（已经有的拉自己进去再打开）。
//   · 管组织架构的人在页面顶上选手机号谁能看（OA19）。

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, MessageCircle, Search, Users } from 'lucide-react';
import { DIRECTORY_PHONE_SCOPES, matchPerson, type Directory, type DirectoryDepartment, type DirectoryPerson, type DirectoryPhoneScope } from '@shared/oa-directory';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, InfoItem, Input, Select, Skeleton } from '../../components/ui';

const KEY = ['oa', 'directory'] as const;

export function DirectoryPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const me = useSession().staff.id;
  const dir = useQuery({ queryKey: KEY, queryFn: () => api.get<Directory>('/api/oa/directory') });
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [person, setPerson] = useState<DirectoryPerson | null>(null);
  const [busy, setBusy] = useState('');
  const d = dir.data;

  const byDept = useMemo(() => {
    const m = new Map<string, DirectoryPerson[]>();
    for (const p of d?.people ?? []) m.set(p.department ?? '', [...(m.get(p.department ?? '') ?? []), p]);
    return m;
  }, [d]);
  const deptName = (key: string | null) => d?.departments.find((x) => x.key === key)?.name ?? '未分部门';
  const matches = q.trim() ? (d?.people ?? []).filter((p) => matchPerson(p, q)) : [];

  const chat = async (staffId: number) => {
    setBusy(`chat-${staffId}`);
    try {
      const r = await api.post<{ id: number }>('/api/oa/im/direct', { staffId });
      void navigate(`/oa/im/${r.id}`);
    } catch (e) {
      toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
    } finally {
      setBusy('');
    }
  };
  const deptGroup = async (dept: DirectoryDepartment) => {
    if (dept.group?.id) return void navigate(`/oa/im/${dept.group.id}`);
    setBusy(`dept-${dept.key}`);
    try {
      const r = await api.post<{ id: number; created: boolean }>('/api/oa/im/dept-groups', { deptKey: dept.key });
      if (r.created) toast({ tone: 'success', title: `「${dept.name}群」建好了`, body: '本部门的同事已经自动加入' });
      void qc.invalidateQueries({ queryKey: KEY });
      void navigate(`/oa/im/${r.id}`);
    } catch (e) {
      // 结果不确定时刷新看现状（再点一次：已经建好的会直接打开，不会另建）
      toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
      void qc.invalidateQueries({ queryKey: KEY });
    } finally {
      setBusy('');
    }
  };
  const saveScope = async (phoneScope: DirectoryPhoneScope) => {
    setBusy('scope');
    try {
      await api.put('/api/oa/directory/settings', { phoneScope });
      await qc.invalidateQueries({ queryKey: KEY });
      toast({ tone: 'success', title: '已保存' });
    } catch (e) {
      toast({ tone: 'error', title: '没有办成', body: errorMessage(e) });
    } finally {
      setBusy('');
    }
  };

  const toggle = (key: string) => setOpen((s) => (s.has(key) ? new Set([...s].filter((x) => x !== key)) : new Set([...s, key])));
  const personRow = (p: DirectoryPerson) => (
    <li key={p.staffId}>
      <button type="button" className="tap flex w-full items-center gap-3 py-2 text-left" onClick={() => setPerson(p)} data-testid={`dir-person-${p.staffId}`}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-pine-tint font-bold text-pine">{p.name.slice(0, 1)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-semibold text-ink">{p.name}</span>
            {p.headOf.length > 0 && <Badge tone="pine">主管</Badge>}
          </span>
          <span className="block truncate text-[13px] text-ink-3">
            {p.positionName}
            {p.empNo ? ` · ${p.empNo}` : ''}
          </span>
        </span>
      </button>
    </li>
  );
  const deptNode = (dept: DirectoryDepartment, depth: number): React.ReactNode => {
    const people = byDept.get(dept.key) ?? [];
    const children = d!.departments.filter((x) => x.parentKey === dept.key);
    const expanded = open.has(dept.key);
    const canGroup = !!dept.group?.id || dept.canCreateGroup;
    return (
      <div key={dept.key} className={depth ? 'border-l border-line pl-2' : ''} data-testid={`dir-dept-${dept.key}`}>
        <div className="flex items-center gap-2 py-2">
          <button type="button" className="tap flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => toggle(dept.key)} aria-expanded={expanded}>
            {expanded ? <ChevronDown className="size-4 shrink-0 text-ink-3" /> : <ChevronRight className="size-4 shrink-0 text-ink-3" />}
            <span className="truncate font-semibold text-ink">{dept.name}</span>
            <span className="num shrink-0 text-[12px] text-ink-3">{people.length} 人</span>
          </button>
          {canGroup && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Users className="size-4" />}
              loading={busy === `dept-${dept.key}`}
              onClick={() => void deptGroup(dept)}
              aria-label={dept.group ? `${dept.name}的部门群` : `建${dept.name}的部门群`}
              data-testid={`dir-dept-group-${dept.key}`}
            >
              {/* 手机上只留图标：部门名更要紧 */}
              <span className="hidden sm:inline">{dept.group ? '部门群' : '建部门群'}</span>
            </Button>
          )}
        </div>
        {expanded && (
          <div className="pb-1 pl-4">{people.length > 0 ? <ul className="divide-y divide-line">{people.map(personRow)}</ul> : <p className="py-1 text-[13px] text-ink-3">没有在职员工</p>}</div>
        )}
        {children.length > 0 && <div className="pl-1">{children.map((c) => deptNode(c, depth + 1))}</div>}
      </div>
    );
  };

  return (
    <>
      <PageHeader dateMode="calendar" title="通讯录" subtitle="全公司在职同事，按部门排；点一个人看资料、发消息" />
      <div className="mx-auto w-full max-w-3xl p-4 md:p-7">
        <Card className="p-4 md:p-5" data-testid="dir">
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value.slice(0, 30))} placeholder="搜姓名、工号、手机号" className="pl-9" aria-label="搜索同事" data-testid="dir-search" />
          </div>
          {dir.isPending ? (
            <Skeleton className="h-60" />
          ) : dir.isError && !d ? (
            <LoadFailed title="通讯录没有取回来" onRetry={() => dir.refetch()} retrying={dir.isFetching} />
          ) : q.trim() ? (
            matches.length ? (
              <ul className="divide-y divide-line" data-testid="dir-results">
                {matches.map(personRow)}
              </ul>
            ) : (
              <EmptyState title="没有搜到" description={d!.canSeePhones ? undefined : '手机号看不到的同事不能按手机号搜'} />
            )
          ) : (
            <div>{d!.departments.filter((x) => !x.parentKey).map((x) => deptNode(x, 0))}</div>
          )}
          {d?.canConfigure && (
            <div className="mt-4 border-t border-line pt-4">
              <Field label="手机号谁能看" hint="自己的手机号自己总能看；看不到的显示打码的号码">
                <Select value={d.phoneScope} disabled={busy === 'scope'} onChange={(e) => void saveScope(e.target.value as DirectoryPhoneScope)} data-testid="dir-phone-scope">
                  {DIRECTORY_PHONE_SCOPES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </Card>
      </div>
      <Dialog
        open={!!person}
        onClose={() => setPerson(null)}
        title={person?.name ?? ''}
        footer={
          person && person.staffId !== me ? (
            <Button size="lg" icon={<MessageCircle className="size-4" />} loading={busy === `chat-${person.staffId}`} onClick={() => void chat(person.staffId)} data-testid="dir-chat">
              发消息
            </Button>
          ) : undefined
        }
      >
        {person && (
          <dl className="grid grid-cols-2 gap-3" data-testid="dir-card">
            <InfoItem label="部门">{deptName(person.department)}</InfoItem>
            <InfoItem label="岗位">{person.positionName}</InfoItem>
            <InfoItem label="工号">{person.empNo ?? '—'}</InfoItem>
            <InfoItem label="手机号">
              {person.phone ? (
                person.phoneMasked ? (
                  <span className="num text-ink-3">{person.phone}</span>
                ) : (
                  <a href={`tel:${person.phone}`} className="num underline">
                    {person.phone}
                  </a>
                )
              ) : (
                '—'
              )}
            </InfoItem>
            {person.headOf.length > 0 && (
              <InfoItem label="主管" full>
                {person.headOf.map((k) => deptName(k)).join('、')}
              </InfoItem>
            )}
          </dl>
        )}
      </Dialog>
    </>
  );
}
