// 员工办公 v1.1 第 5 批（docs/OA_MOBILE.md 第五节）：后台「WCP 设置 → 公司公告」（权限 oa.announce）。
//   · 发布公告（标题、全员或指定部门、置顶、正文、附件；带操作编号幂等 + 结果待确认保护）；
//   · 编辑 / 置顶切换（带乐观锁 version）；
//   · 撤回公告（必填原因，带操作编号幂等 + 结果待确认保护；撤回后员工不可见、未读通知隐藏）；
//   · 查看已读名单（谁读了、何时读、目标范围总人数）。

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Megaphone, Paperclip, Pencil, Pin, Plus, Undo2, X } from 'lucide-react';
import {
  ANNOUNCEMENT_ATTACHMENTS_MAX,
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  type AnnouncementScope,
  type OaAnnouncement,
  type OaAnnouncementReaders,
  type OaAnnouncementSaved,
  type OaAttachment,
} from '@shared/oa';
import { ORG_DEPARTMENTS, type OrgDepartment } from '@shared/positions';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpRecorded } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Skeleton, Textarea } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { uploadFile } from './oaImage';

const KEY = ['oa', 'admin-announcements'] as const;
const DEPT_NAME = new Map<OrgDepartment, string>(ORG_DEPARTMENTS.map((d) => [d.key, d.name]));
const scopeText = (a: OaAnnouncement) => (a.scope === 'all' ? '全员' : a.targetDepts.map((k) => DEPT_NAME.get(k) ?? k).join('、'));

export function AnnouncementsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<OaAnnouncement[]>('/api/admin/oa/announcements') });
  const pending = useErpRecorded(['oa_announcement']);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<OaAnnouncement | null>(null);
  const [recalling, setRecalling] = useState<OaAnnouncement | null>(null);
  const [readersOf, setReadersOf] = useState<OaAnnouncement | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [recallBusy, setRecallBusy] = useState(false);

  const togglePin = async (a: OaAnnouncement) => {
    if (pending.length) {
      toast({ tone: 'error', title: '上一次公告操作结果待确认，请先在页面上方处理' });
      return;
    }
    setBusyId(a.id);
    const clientKey = uuid();
    try {
      await sendErpOp<OaAnnouncementSaved>({
        key: clientKey,
        type: 'oa_announcement',
        url: `/api/admin/oa/announcements/${a.id}/update`,
        body: {
          clientKey,
          title: a.title,
          body: a.body,
          pinned: !a.pinned,
          version: a.version,
        },
        summary: `${a.pinned ? '取消置顶' : '置顶'}公告「${a.title}」`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: a.pinned ? '已取消置顶' : '已置顶' });
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '置顶状态修改结果待确认', body: '已记在本机，请在页面上方查回、重提或作废。' });
      } else if (e instanceof ErpPendingStoreError) {
        toast({ tone: 'error', title: e.message });
      } else {
        toast({ tone: 'error', title: errorMessage(e) });
      }
    } finally {
      setBusyId(null);
    }
  };

  const confirmRecall = async (reason: string) => {
    if (!recalling) return;
    if (pending.length) {
      toast({ tone: 'error', title: '上一次公告操作结果待确认，请先在页面上方处理' });
      return;
    }
    setRecallBusy(true);
    const clientKey = uuid();
    try {
      await sendErpOp<OaAnnouncementSaved>({
        key: clientKey,
        type: 'oa_announcement',
        url: `/api/admin/oa/announcements/${recalling.id}/recall`,
        body: { clientKey, reason },
        summary: `撤回公告「${recalling.title}」`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: '已撤回公告' });
      setRecalling(null);
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '撤回结果待确认', body: '已记在本机，请在页面上方查回、重提或作废。' });
        setRecalling(null);
      } else if (e instanceof ErpPendingStoreError) toast({ tone: 'error', title: e.message });
      else toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setRecallBusy(false);
    }
  };

  return (
    <AdminPage
      section="announcements"
      wide
      description="向全店或指定部门在职员工发布通知公告，自动推送站内通知并跟踪已读名单；已发布的公告可编辑、置顶或撤回。"
      actions={
        <Button icon={<Plus className="size-4" />} disabled={pending.length > 0} onClick={() => setCreating(true)} data-testid="admin-ann-new">
          发布公告
        </Button>
      }
    >
      <ErpPendingPanel types={['oa_announcement']} className="mb-4 space-y-2" onFound={() => void qc.invalidateQueries({ queryKey: KEY })} />
      {pending.length > 0 && (
        <Notice tone="warning" className="mb-4">
          有公告操作结果待确认，请先在上方查回、原样重提或作废后再新建、修改或撤回。
        </Notice>
      )}
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="公告列表没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : q.data.length === 0 ? (
        <EmptyState title="还没有发布过公告" description="点右上角「发布公告」，向全员或指定部门推送通知。" />
      ) : (
        <div className="space-y-3" data-testid="admin-ann-list">
          {q.data.map((a) => (
            <Card key={a.id} className="p-4 md:p-5" data-testid={`admin-ann-${a.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {a.status === 'recalled' ? <Badge>已撤回</Badge> : <Badge tone="pine">已发布</Badge>}
                    {a.pinned && (
                      <Badge tone="clay">
                        <Pin className="mr-0.5 inline size-3" />
                        置顶
                      </Badge>
                    )}
                    <Badge tone={a.scope === 'all' ? 'pine' : 'lake'}>{scopeText(a)}</Badge>
                    <h2 className="break-words text-[16px] font-bold text-ink">{a.title}</h2>
                  </div>
                  <p className="line-clamp-3 break-words whitespace-pre-wrap text-[13.5px] text-ink-2">{a.body}</p>
                  <p className="flex flex-wrap items-center gap-3 text-[12.5px] text-ink-3">
                    <span>发布人：{a.publishedByName}</span>
                    <span className="num">{formatDateTime(a.publishedAt)}</span>
                    <span className="num font-semibold text-ink-2" data-testid={`admin-ann-readcount-${a.id}`}>
                      已读 {a.readCount ?? 0} / {a.targetCount ?? 0}
                    </span>
                    {a.attachments.length > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Paperclip className="size-3.5" />
                        {a.attachments.length} 个附件
                      </span>
                    )}
                  </p>
                  {a.status === 'recalled' && (
                    <p className="text-[12.5px] text-clay">
                      已由 {a.recalledByName} 于 {a.recalledAt ? formatDateTime(a.recalledAt) : ''} 撤回：{a.recallReason}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button size="sm" variant="ghost" icon={<Eye className="size-4" />} onClick={() => setReadersOf(a)} data-testid={`admin-ann-readers-${a.id}`}>
                    已读名单
                  </Button>
                  {a.status === 'published' && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Pin className="size-4" />}
                        loading={busyId === a.id}
                        disabled={pending.length > 0}
                        onClick={() => void togglePin(a)}
                        data-testid={`admin-ann-pin-${a.id}`}
                      >
                        {a.pinned ? '取消置顶' : '置顶'}
                      </Button>
                      <Button size="sm" variant="secondary" icon={<Pencil className="size-4" />} disabled={pending.length > 0} onClick={() => setEditing(a)} data-testid={`admin-ann-edit-${a.id}`}>
                        编辑
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} disabled={pending.length > 0} onClick={() => setRecalling(a)} data-testid={`admin-ann-recall-${a.id}`}>
                        撤回
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {creating && (
        <PublishDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: KEY });
          }}
        />
      )}
      {editing && (
        <EditDialog
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: KEY });
          }}
        />
      )}
      <ReasonDialog
        open={!!recalling}
        title={recalling ? `撤回公告「${recalling.title}」` : ''}
        description="撤回后员工将不再看到这条公告，对应的未读站内通知也会自动隐藏。"
        confirmLabel="确认撤回"
        danger
        busy={recallBusy}
        testId="admin-ann-recall-reason"
        onClose={() => setRecalling(null)}
        onConfirm={(reason) => void confirmRecall(reason)}
      />
      {readersOf && <ReadersDialog item={readersOf} onClose={() => setReadersOf(null)} />}
    </AdminPage>
  );
}

function PublishDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const session = useSession();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<AnnouncementScope>('all');
  const [depts, setDepts] = useState<OrgDepartment[]>([]);
  const [pinned, setPinned] = useState(false);
  const [attachments, setAttachments] = useState<OaAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const toggleDept = (k: OrgDepartment) => setDepts((xs) => (xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]));
  const onPickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      let count = attachments.length;
      for (const file of Array.from(files)) {
        if (count >= ANNOUNCEMENT_ATTACHMENTS_MAX) break;
        const uploaded = await uploadFile(file);
        count += 1;
        setAttachments((xs) => [...xs, uploaded]);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = async () => {
    if (!title.trim()) return setError('请填写公告标题');
    if (!body.trim()) return setError('请填写公告正文');
    if (scope === 'dept' && depts.length === 0) return setError('请选择至少一个部门');
    setBusy(true);
    setError(null);
    const clientKey = uuid();
    try {
      await sendErpOp<OaAnnouncementSaved>({
        key: clientKey,
        type: 'oa_announcement',
        url: '/api/admin/oa/announcements',
        body: {
          clientKey,
          title: title.trim(),
          body: body.trim(),
          scope,
          targetDepts: scope === 'dept' ? depts : [],
          pinned,
          attachmentIds: attachments.map((a) => a.id),
        },
        summary: `发布公告「${title.trim()}」`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: '公告已发布并发送站内通知' });
      onSaved();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '发布结果待确认', body: '已记在本机，请在页面上方查回、重提或作废。' });
        onClose();
      } else if (e instanceof ErpPendingStoreError) setError(e.message);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="发布公司公告"
      description="发布后目标范围的在职员工会收到站内通知"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button size="lg" icon={<Megaphone className="size-4" />} loading={busy} disabled={uploading} onClick={() => void submit()} data-testid="admin-ann-submit">
            {uploading ? '附件上传中…' : '发布公告'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="标题">
          <Input value={title} maxLength={ANNOUNCEMENT_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder="例如：11 月消防演练通知" data-testid="admin-ann-title" />
        </Field>
        <Field label="接收范围">
          <Segmented<AnnouncementScope>
            value={scope}
            onChange={setScope}
            ariaLabel="公告接收范围"
            options={[
              { value: 'all', label: <span data-testid="admin-ann-scope-all">全员</span> },
              { value: 'dept', label: <span data-testid="admin-ann-scope-dept">指定部门</span> },
            ]}
          />
        </Field>
        {scope === 'dept' && (
          <div className="flex flex-wrap gap-2 rounded-md border border-line bg-paper-2 p-2.5" data-testid="admin-ann-depts">
            {ORG_DEPARTMENTS.map((d) => (
              <label key={d.key} className="tap relative inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-1 text-[13px]">
                <input type="checkbox" checked={depts.includes(d.key)} onChange={() => toggleDept(d.key)} className="size-4 accent-pine" data-testid={`admin-ann-dept-${d.key}`} />
                {d.name}
              </label>
            ))}
          </div>
        )}
        <label className="tap relative inline-flex cursor-pointer items-center gap-2 text-[14px] text-ink">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="size-4 accent-pine" data-testid="admin-ann-pinned" />
          置顶显示
        </label>
        <Field label="正文">
          <Textarea value={body} maxLength={ANNOUNCEMENT_BODY_MAX} rows={5} onChange={(e) => setBody(e.target.value)} placeholder="写明事项、时间与要求" data-testid="admin-ann-body" />
        </Field>
        <Field label={`附件（最多 ${ANNOUNCEMENT_ATTACHMENTS_MAX} 个，可不传）`}>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {attachments.map((att) => (
                <span key={att.id} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper-2 px-2.5 py-1 text-[13px]">
                  <Paperclip className="size-3.5 text-ink-3" />
                  <span className="max-w-44 truncate">{att.fileName}</span>
                  <button type="button" onClick={() => setAttachments((xs) => xs.filter((x) => x.id !== att.id))} aria-label="移除附件" className="text-ink-3 hover:text-ink">
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
            </div>
            {attachments.length < ANNOUNCEMENT_ATTACHMENTS_MAX && (
              <>
                <Button size="sm" variant="secondary" icon={<Paperclip className="size-4" />} loading={uploading} onClick={() => fileRef.current?.click()}>
                  添加附件
                </Button>
                <input ref={fileRef} type="file" multiple hidden onChange={(e) => void onPickFiles(e.target.files)} />
              </>
            )}
          </div>
        </Field>
        {error && (
          <p className="text-[13px] text-clay" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function EditDialog({ item, onClose, onSaved }: { item: OaAnnouncement; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const session = useSession();
  const pending = useErpRecorded(['oa_announcement']);
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [pinned, setPinned] = useState(item.pinned);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (pending.length) return setError('上一次公告操作结果待确认，请先在页面上方处理');
    if (!title.trim() || !body.trim()) return setError('标题和正文不能为空');
    setBusy(true);
    setError(null);
    const clientKey = uuid();
    try {
      await sendErpOp<OaAnnouncementSaved>({
        key: clientKey,
        type: 'oa_announcement',
        url: `/api/admin/oa/announcements/${item.id}/update`,
        body: {
          clientKey,
          title: title.trim(),
          body: body.trim(),
          pinned,
          version: item.version,
        },
        summary: `修改公告「${title.trim()}」`,
        staffName: session.staff.displayName,
        staffId: session.staff.id,
      });
      toast({ tone: 'success', title: '已保存修改' });
      onSaved();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '修改结果待确认', body: '已记在本机，请在页面上方查回、重提或作废。' });
        onClose();
      } else if (e instanceof ErpPendingStoreError) {
        setError(e.message);
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="编辑公告"
      description="仅修改标题、正文或置顶状态；如需变更接收范围请撤回后重新发布"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button size="lg" loading={busy} onClick={() => void save()} data-testid="admin-ann-edit-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="标题">
          <Input value={title} maxLength={ANNOUNCEMENT_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} data-testid="admin-ann-edit-title" />
        </Field>
        <label className="tap relative inline-flex cursor-pointer items-center gap-2 text-[14px] text-ink">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="size-4 accent-pine" />
          置顶显示
        </label>
        <Field label="正文">
          <Textarea value={body} maxLength={ANNOUNCEMENT_BODY_MAX} rows={5} onChange={(e) => setBody(e.target.value)} data-testid="admin-ann-edit-body" />
        </Field>
        {error && (
          <p className="text-[13px] text-clay" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function ReadersDialog({ item, onClose }: { item: OaAnnouncement; onClose: () => void }) {
  const q = useQuery({ queryKey: ['oa', 'admin-ann-readers', item.id], queryFn: () => api.get<OaAnnouncementReaders>(`/api/admin/oa/announcements/${item.id}/readers`) });
  return (
    <Dialog open onClose={onClose} title={`已读名单 · ${item.title}`}>
      {q.isPending ? (
        <Skeleton className="h-32" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="已读名单没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="space-y-3" data-testid="admin-ann-readers-list">
          <p className="text-[13px] text-ink-3">
            已读 <b className="num text-ink">{q.data!.readers.length}</b> / <span className="num">{q.data!.targetCount}</span> 人
          </p>
          {q.data!.readers.length === 0 ? (
            <EmptyState title="还没有人读过" />
          ) : (
            <ul className="max-h-72 divide-y divide-line overflow-y-auto">
              {q.data!.readers.map((r) => (
                <li key={r.staffId} className="flex items-center justify-between gap-2 py-2 text-[13.5px]">
                  <span>
                    <b className="text-ink">{r.name}</b>
                    {r.department && <span className="ml-2 text-[12.5px] text-ink-3">{r.department}</span>}
                  </span>
                  <span className="num text-[12px] text-ink-3">{formatDateTime(r.readAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
