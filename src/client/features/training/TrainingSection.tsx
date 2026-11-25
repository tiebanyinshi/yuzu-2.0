// 员工培训 · 管理（后台「人员与行政 → 员工培训」，docs/TRAINING.md）：
//   · 左边文件夹：「培训资料」（全员）+ 每个部门一个；新建部门文件夹、改名、排序、停用；
//   · 右边这个夹里的文件：上传（可一次选多个，分块传、断了接着传）、看过人数、点开改标题 / 说明 / 文件夹、上下架、换新版本、看谁看过、预览。

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, FolderPlus, Pencil, Upload } from 'lucide-react';
import { fileSizeText } from '@shared/floorplans';
import { ORG_DEPARTMENTS } from '@shared/positions';
import { TRAINING_ACCEPT, TRAINING_MAX_BYTES, trainingFormatLabel, type TrainingFile, type TrainingFileDetail, type TrainingFolder } from '@shared/training';
import { api, errorMessage } from '../../lib/api';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { trainingKeys, useTrainingFiles, useTrainingFolders } from './TrainingPages';
import { uploadTrainingFile } from './upload';
import { DownloadButton, TrainingViewer } from './TrainingViewer';

export function TrainingSection() {
  const folders = useTrainingFolders();
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<TrainingFolder | 'new' | null>(null);
  const list = folders.data?.folders ?? [];
  const current = list.find((f) => f.id === selected) ?? list[0] ?? null;
  return (
    <AdminPage
      section="training"
      wide
      description="培训文件按文件夹放：「培训资料」所有员工都看得到，部门文件夹只有这个部门的员工看得到（自己新建、不对应部门的所有人都看得到）。员工在「WCP → 员工培训」里看。"
    >
      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <Card className="p-4" data-testid="training-admin-folders">
          <SectionTitle
            aside={
              <Button size="sm" variant="secondary" icon={<FolderPlus className="size-4" />} onClick={() => setEditing('new')} data-testid="training-folder-new">
                新建
              </Button>
            }
          >
            文件夹
          </SectionTitle>
          {folders.isPending ? (
            <Skeleton className="mt-3 h-60" />
          ) : folders.isError && !folders.data ? (
            <LoadFailed title="文件夹没有取回来" onRetry={() => folders.refetch()} retrying={folders.isFetching} />
          ) : (
            <div className="mt-3 space-y-1">
              {list.map((f) => (
                <div key={f.id} className={cn('flex items-center gap-1 rounded-md', current?.id === f.id ? 'bg-pine-tint' : 'hover:bg-paper-2')}>
                  <button
                    type="button"
                    onClick={() => setSelected(f.id)}
                    className="tap relative flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                    data-testid={`training-admin-folder-${f.id}`}
                  >
                    <FolderOpen className={cn('size-4 shrink-0', f.active ? 'text-pine' : 'text-ink-4')} />
                    <span className={cn('min-w-0 flex-1 truncate text-[14px] font-semibold', !f.active && 'text-ink-4 line-through')}>{f.name}</span>
                    <span className="num text-[12px] text-ink-3">{f.fileCount}</span>
                  </button>
                  <button type="button" onClick={() => setEditing(f)} className="tap relative rounded p-2 text-ink-3 hover:text-ink" aria-label={`修改文件夹 ${f.name}`}>
                    <Pencil className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
        {current ? <FolderFiles folder={current} folders={list} /> : <Skeleton className="h-60" />}
      </div>
      {editing && <FolderDialog folder={editing === 'new' ? null : editing} taken={list} onClose={() => setEditing(null)} onSaved={(f) => (setEditing(null), setSelected(f.id))} />}
    </AdminPage>
  );
}

function FolderDialog({ folder, taken, onClose, onSaved }: { folder: TrainingFolder | null; taken: TrainingFolder[]; onClose: () => void; onSaved: (f: TrainingFolder) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(folder?.name ?? '');
  const [sort, setSort] = useState(String(folder?.sort ?? 200));
  const [active, setActive] = useState(folder?.active ?? true);
  const [dept, setDept] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const freeDepts = ORG_DEPARTMENTS.filter((d) => !taken.some((f) => f.departmentKey === d.key));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = folder
        ? await api.put<TrainingFolder>(`/api/admin/training/folders/${folder.id}`, { name: name.trim(), sort: Number(sort) || 0, active, version: folder.version })
        : await api.post<TrainingFolder>('/api/admin/training/folders', { name: name.trim(), departmentKey: dept || null, sort: Number(sort) || 0 });
      await qc.invalidateQueries({ queryKey: trainingKeys.folders });
      toast({ tone: 'success', title: folder ? `文件夹「${saved.name}」已保存` : `已新建文件夹「${saved.name}」` });
      onSaved(saved);
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
      title={folder ? `修改文件夹 · ${folder.name}` : '新建部门文件夹'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save} data-testid="training-folder-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} data-testid="training-folder-name" autoFocus />
        </Field>
        {!folder && freeDepts.length > 0 && (
          <Field label="对应的部门" hint="选了只有这个部门的员工看得到；不选 = 新的部门或小组，所有员工都看得到">
            <Select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="对应的部门">
              <option value="">不对应（所有员工都看得到）</option>
              {freeDepts.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="排序" hint="小的在前">
          <Input value={sort} onChange={(e) => setSort(e.target.value)} inputMode="numeric" className="num w-28" />
        </Field>
        {folder && folder.kind !== 'public' && (
          <Field label="启用">
            <Segmented
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              options={[
                { value: 'on', label: '启用' },
                { value: 'off', label: '停用（员工看不到）' },
              ]}
            />
          </Field>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

type UploadRow = { key: string; file: File; progress: number; error: string | null; done: boolean };

function FolderFiles({ folder, folders }: { folder: TrainingFolder; folders: TrainingFolder[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useTrainingFiles(folder.id);
  const input = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [open, setOpen] = useState<TrainingFile | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: trainingKeys.files(folder.id) }), qc.invalidateQueries({ queryKey: trainingKeys.folders })]);

  const run = async (rows: UploadRow[]) => {
    for (const row of rows) {
      const set = (patch: Partial<UploadRow>) => setUploads((all) => all.map((r) => (r.key === row.key ? { ...r, ...patch } : r)));
      set({ error: null });
      try {
        await uploadTrainingFile(row.file, row.key, { folderId: folder.id }, (p) => set({ progress: p }));
        set({ done: true, progress: 1 });
      } catch (e) {
        set({ error: errorMessage(e) });
      }
    }
    await refresh();
  };
  const pick = (files: FileList | null) => {
    if (!files?.length) return;
    const rows: UploadRow[] = [];
    for (const f of Array.from(files)) {
      if (f.size > TRAINING_MAX_BYTES) {
        toast({ tone: 'error', title: `「${f.name}」超过 ${TRAINING_MAX_BYTES / 1024 / 1024} MB`, body: '视频请先压成 720p 的 MP4 再传' });
        continue;
      }
      rows.push({ key: uuid(), file: f, progress: 0, error: null, done: false });
    }
    setUploads((all) => [...all.filter((r) => !r.done), ...rows]);
    void run(rows);
  };

  const columns: DataColumn<TrainingFile>[] = [
    {
      key: 'title',
      header: '标题',
      cell: (f) => (
        <span className={cn('font-semibold', !f.active && 'text-ink-4 line-through')}>
          {f.title}
          {!f.active && <Badge className="ml-2">已下架</Badge>}
        </span>
      ),
    },
    { key: 'kind', header: '类型', cell: (f) => trainingFormatLabel(f.current.mime) },
    { key: 'size', header: '大小', numeric: true, cell: (f) => fileSizeText(f.current.sizeBytes) },
    { key: 'ver', header: '版本', numeric: true, cell: (f) => `第 ${f.current.versionNo} 版` },
    { key: 'viewers', header: '看过', numeric: true, cell: (f) => `${f.viewerCount ?? 0} 人` },
    { key: 'at', header: '更新', cell: (f) => formatDateTime(f.current.createdAt) },
  ];

  return (
    <Card className="p-4" data-testid="training-admin-files">
      <SectionTitle
        aside={
          <>
            <input ref={input} type="file" multiple accept={TRAINING_ACCEPT} className="hidden" onChange={(e) => (pick(e.target.files), (e.target.value = ''))} data-testid="training-upload-input" />
            <Button size="sm" variant="primary" icon={<Upload className="size-4" />} onClick={() => input.current?.click()} data-testid="training-upload">
              上传文件
            </Button>
          </>
        }
      >
        {folder.name}
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        能传 PDF、图片、视频（MP4）、音频、Excel、PPT、Word，一份最多 {TRAINING_MAX_BYTES / 1024 / 1024} MB，可以一次选多个。PDF、图片、视频、Excel 员工在页面里直接看，PPT、Word
        员工下载看（想在页面里看，再传一份「另存为 PDF」的）。
        <PendingBadge className="ml-1" title="谁能看、文件大小上限、Office 预览的做法待确认（docs/PENDING_DECISIONS.md PC37）" />
      </p>
      {uploads.length > 0 && (
        <div className="mt-3 space-y-2" data-testid="training-uploads">
          {uploads.map((u) => (
            <div key={u.key} className="rounded-md border border-line p-2 text-[13px]">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold">{u.file.name}</span>
                <span className="num text-ink-3">{u.done ? '已上传' : u.error ? '没传完' : `${Math.round(u.progress * 100)}%`}</span>
                {u.error && (
                  <Button size="sm" variant="secondary" onClick={() => void run([u])}>
                    接着传
                  </Button>
                )}
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-paper-2">
                <div className={cn('h-full', u.error ? 'bg-clay' : 'bg-pine')} style={{ width: `${Math.round(u.progress * 100)}%` }} />
              </div>
              {u.error && <p className="mt-1 text-clay">{u.error}</p>}
            </div>
          ))}
        </div>
      )}
      <DataTable
        className="mt-4"
        columns={columns}
        rows={q.data ?? []}
        rowKey={(f) => String(f.id)}
        loading={q.isPending}
        failed={q.isError && !q.data}
        onRetry={() => q.refetch()}
        retrying={q.isFetching}
        empty="这个文件夹里还没有文件"
        emptyDescription="点右上角「上传文件」"
        onRowClick={(f) => setOpen(f)}
        rowTestId={(f) => `training-admin-file-${f.id}`}
      />
      {open && <FileDialog fileId={open.id} folders={folders} onClose={() => setOpen(null)} onChanged={refresh} />}
    </Card>
  );
}

function FileDialog({ fileId, folders, onClose, onChanged }: { fileId: number; folders: TrainingFolder[]; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['training', 'admin-file', fileId], queryFn: () => api.get<TrainingFileDetail>(`/api/admin/training/files/${fileId}`) });
  const [tab, setTab] = useState<'info' | 'versions' | 'viewers' | 'preview'>('info');
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-3xl"
      title={q.data?.file.title ?? '培训文件'}
      description={q.data ? `${trainingFormatLabel(q.data.file.current.mime)} · 第 ${q.data.file.current.versionNo} 版` : undefined}
    >
      {q.isPending ? (
        <Skeleton className="h-60" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="space-y-4">
          <Segmented
            value={tab}
            onChange={setTab}
            ariaLabel="文件详情"
            options={[
              { value: 'info', label: '信息' },
              { value: 'versions', label: `版本 ${q.data.versions.length}` },
              { value: 'viewers', label: `看过 ${q.data.viewers.length}` },
              { value: 'preview', label: '预览' },
            ]}
          />
          {tab === 'info' && (
            <FileInfo
              detail={q.data}
              folders={folders}
              onSaved={async () => {
                await Promise.all([q.refetch(), onChanged()]);
                toast({ tone: 'success', title: '已保存' });
              }}
            />
          )}
          {tab === 'versions' && <Versions detail={q.data} onUploaded={async () => void (await Promise.all([q.refetch(), onChanged()]))} />}
          {tab === 'viewers' && (
            <DataTable
              columns={[
                { key: 'name', header: '员工', cell: (v) => v.name },
                { key: 'dept', header: '部门', cell: (v) => v.department ?? '—' },
                { key: 'count', header: '次数', numeric: true, cell: (v) => v.viewCount },
                { key: 'ver', header: '看的版本', numeric: true, cell: (v) => (v.versionNo ? `第 ${v.versionNo} 版` : '—') },
                { key: 'last', header: '最近一次', cell: (v) => formatDateTime(v.lastViewedAt) },
              ]}
              rows={q.data.viewers}
              rowKey={(v) => String(v.staffId)}
              empty="还没有人看过"
              testId="training-viewers"
            />
          )}
          {tab === 'preview' && <TrainingViewer file={q.data.file} recordView={false} />}
        </div>
      )}
    </Dialog>
  );
}

function FileInfo({ detail, folders, onSaved }: { detail: TrainingFileDetail; folders: TrainingFolder[]; onSaved: () => Promise<void> }) {
  const f = detail.file;
  const [title, setTitle] = useState(f.title);
  const [description, setDescription] = useState(f.description);
  const [folderId, setFolderId] = useState(f.folderId);
  const [active, setActive] = useState(f.active);
  const [sort, setSort] = useState(String(f.sort));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/admin/training/files/${f.id}`, { title: title.trim(), description: description.trim(), folderId, active, sort: Number(sort) || 0, version: f.version });
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4" data-testid="training-file-info">
      <Field label="标题">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} data-testid="training-file-title" />
      </Field>
      <Field label="说明" hint="员工打开时显示在标题下面，可不填">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="文件夹">
          <Select value={folderId} onChange={(e) => setFolderId(Number(e.target.value))} aria-label="文件夹">
            {folders.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="排序" hint="小的在前">
          <Input value={sort} onChange={(e) => setSort(e.target.value)} inputMode="numeric" className="num" />
        </Field>
        <Field label="状态">
          <Segmented
            value={active ? 'on' : 'off'}
            onChange={(v) => setActive(v === 'on')}
            options={[
              { value: 'on', label: '上架' },
              { value: 'off', label: '下架' },
            ]}
          />
        </Field>
      </div>
      {error && <Notice tone="error" title={error} />}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={save} data-testid="training-file-save">
          保存
        </Button>
        <DownloadButton file={f} />
      </div>
    </div>
  );
}

function Versions({ detail, onUploaded }: { detail: TrainingFileDetail; onUploaded: () => Promise<void> }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [state, setState] = useState<{ key: string; file: File; progress: number; error: string | null } | null>(null);
  const run = async (s: { key: string; file: File }) => {
    setState({ ...s, progress: 0, error: null });
    try {
      await uploadTrainingFile(s.file, s.key, { fileId: detail.file.id, note: note.trim() }, (p) => setState((x) => (x ? { ...x, progress: p } : x)));
      setState(null);
      setNote('');
      toast({ tone: 'success', title: '已换成新版本', body: '旧版本留着，员工看到的是新的' });
      await onUploaded();
    } catch (e) {
      setState((x) => (x ? { ...x, error: errorMessage(e) } : x));
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-paper/60 p-3">
        <Field label="新版本说明（可不填）" className="min-w-0 flex-1">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="如：2026 年修订" />
        </Field>
        <input
          ref={input}
          type="file"
          accept={TRAINING_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void run({ key: uuid(), file: f });
          }}
          data-testid="training-version-input"
        />
        <Button variant="secondary" icon={<Upload className="size-4" />} loading={!!state && !state.error} onClick={() => input.current?.click()}>
          上传新版本
        </Button>
      </div>
      {state && (
        <p className={cn('text-[13px]', state.error ? 'text-clay' : 'text-ink-3')}>
          {state.file.name}：{state.error ?? `${Math.round(state.progress * 100)}%`}
          {state.error && (
            <Button size="sm" variant="secondary" className="ml-2" onClick={() => void run(state)}>
              接着传
            </Button>
          )}
        </p>
      )}
      <DataTable
        columns={[
          { key: 'no', header: '版本', numeric: true, cell: (v) => `第 ${v.versionNo} 版` },
          { key: 'name', header: '文件名', cell: (v) => v.fileName },
          { key: 'size', header: '大小', numeric: true, cell: (v) => fileSizeText(v.sizeBytes) },
          { key: 'by', header: '上传人', cell: (v) => v.uploadedByName },
          { key: 'at', header: '时间', cell: (v) => formatDateTime(v.createdAt) },
          { key: 'note', header: '说明', cell: (v) => v.note || '—' },
          { key: 'dl', header: '', cell: (v) => <DownloadButton file={detail.file} versionId={v.id} label="下载" /> },
        ]}
        rows={detail.versions}
        rowKey={(v) => String(v.id)}
        testId="training-versions"
      />
    </div>
  );
}
