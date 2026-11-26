// 员工培训 / WCP 知识库 · 员工端（docs/TRAINING.md；员工办公 v1.1 第 5 批 docs/OA_MOBILE.md）：
//   /oa/training                     看得到的文件夹 + 置顶检索栏（同步 ?q=，全库搜索本人可见文档）
//   /oa/training/<文件夹>            这个夹里的文件（看过的标「已看」）
//   /oa/training/<文件夹>/<文件>     看这份文件（PDF、图片、视频、Excel 页面里直接看，PPT、Word 下载）

import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, FileText, FolderOpen, Search, X } from 'lucide-react';
import { fileSizeText } from '@shared/floorplans';
import { trainingFormatLabel, type TrainingFile, type TrainingFolderList, type TrainingSearchItem } from '@shared/training';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Card, Input, Skeleton } from '../../components/ui';
import { TrainingViewer } from './TrainingViewer';

export const trainingKeys = {
  folders: ['training', 'folders'] as const,
  files: (folderId: number) => ['training', 'files', folderId] as const,
  search: (q: string) => ['training', 'search', q] as const,
};

export function useTrainingFolders() {
  return useQuery({ queryKey: trainingKeys.folders, queryFn: () => api.get<TrainingFolderList>('/api/training/folders') });
}
export function useTrainingFiles(folderId: number | null) {
  return useQuery({
    queryKey: trainingKeys.files(folderId ?? 0),
    queryFn: () => api.get<TrainingFile[]>(`/api/training/folders/${folderId}/files`),
    enabled: folderId !== null,
  });
}

export function TrainingPages() {
  const { pathname } = useLocation();
  const [, , , folder, file] = pathname.replace(/\/$/, '').split('/');
  const folderId = folder ? Number(folder) : null;
  const fileId = file ? Number(file) : null;
  if (folderId && fileId) return <FilePage folderId={folderId} fileId={fileId} />;
  if (folderId) return <FolderPage folderId={folderId} />;
  return <FoldersPage />;
}

function Back({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="tap relative inline-flex items-center gap-1 text-[14px] font-semibold text-pine">
      <ChevronLeft className="size-4" />
      {label}
    </Link>
  );
}

function FoldersPage() {
  const q = useTrainingFolders();
  const [params, setParams] = useSearchParams();
  const urlQ = (params.get('q') ?? '').trim();
  const [term, setTerm] = useState(urlQ);
  useEffect(() => {
    setTerm(urlQ);
  }, [urlQ]);
  const applySearch = (raw: string) => {
    const next = raw.trim();
    const p = new URLSearchParams(params);
    if (next) p.set('q', next);
    else p.delete('q');
    setParams(p, { replace: true });
  };
  const search = useQuery({
    queryKey: trainingKeys.search(urlQ),
    queryFn: () => api.get<TrainingSearchItem[]>(`/api/training/search?q=${encodeURIComponent(urlQ)}`),
    enabled: urlQ.length > 0,
  });
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader title="知识库 · 员工培训" subtitle="公司的培训资料和本部门的培训文件，支持全文名称检索与手机在线预览" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-[17px] font-bold text-ink md:hidden">知识库</h1>
          <div className="max-md:hidden">
            <Back to="/oa" label="WCP 首页" />
          </div>
        </div>
        {/* 置顶搜索栏（PC 与手机共用；手机顶栏搜索也会同步写入 ?q=） */}
        <form
          role="search"
          className="sticky top-0 z-10 flex items-center gap-2 rounded-lg border border-line bg-card p-2 shadow-card"
          onSubmit={(e) => {
            e.preventDefault();
            applySearch(term);
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input
              value={term}
              maxLength={60}
              onChange={(e) => {
                setTerm(e.target.value);
                if (!e.target.value.trim() && urlQ) applySearch('');
              }}
              placeholder="搜索文档标题、说明或文件名"
              aria-label="搜索知识库"
              className="pr-8 pl-9"
              data-testid="training-search-input"
            />
            {term && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => {
                  setTerm('');
                  applySearch('');
                }}
                className="tap absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 hover:text-ink"
                data-testid="training-search-clear"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <button type="submit" className="tap relative inline-flex h-10 shrink-0 items-center rounded-md bg-pine px-3.5 text-[14px] font-semibold text-white" data-testid="training-search-submit">
            搜索
          </button>
        </form>

        {urlQ ? (
          <div className="space-y-2" data-testid="training-search-results">
            <p className="px-1 text-[13px] text-ink-3">
              「{urlQ}」{search.data ? `找到 ${search.data.length} 份文档` : '搜索中…'}
            </p>
            {search.isPending ? (
              <Skeleton className="h-32" />
            ) : search.isError && !search.data ? (
              <LoadFailed title="知识库检索失败" onRetry={() => search.refetch()} retrying={search.isFetching} />
            ) : search.data!.length === 0 ? (
              <EmptyState title="没有搜到相关文档" description="换个关键词试试，或清空后按文件夹浏览。" />
            ) : (
              search.data!.map((item) => (
                <Link
                  key={`${item.folderId}-${item.file.id}`}
                  to={`/oa/training/${item.folderId}/${item.file.id}`}
                  data-testid={`training-search-hit-${item.file.id}`}
                  className="tap relative flex items-center gap-3 rounded-lg border border-line bg-card p-3 hover:border-line-strong"
                >
                  <FileText className="size-5 shrink-0 text-pine" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[15px] font-semibold text-ink">{item.file.title}</span>
                      <Badge tone="neutral">{item.folderName}</Badge>
                      {!item.file.active && <Badge>已下架</Badge>}
                    </span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-ink-3">
                      {trainingFormatLabel(item.file.current.mime)} · {fileSizeText(item.file.current.sizeBytes)} · 更新于 {formatDateTime(item.file.current.createdAt)}
                    </span>
                  </span>
                  {item.file.myLastViewedAt ? <Badge tone="pine">已看</Badge> : <Badge tone="clay">未看</Badge>}
                </Link>
              ))
            )}
          </div>
        ) : q.isPending ? (
          <Skeleton className="h-40" />
        ) : q.isError && !q.data ? (
          <LoadFailed title="文件夹没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:gap-3" data-testid="training-folders">
            {q.data.folders.map((f) => (
              <Link
                key={f.id}
                to={`/oa/training/${f.id}`}
                data-testid={`training-folder-${f.id}`}
                className="tap relative flex items-center gap-3 rounded-lg border border-line bg-card p-3.5 shadow-card hover:border-line-strong md:p-4"
              >
                <FolderOpen className="size-6 shrink-0 text-pine" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold text-ink">{f.name}</span>
                  <span className="text-[13px] text-ink-3">{f.fileCount} 份文件</span>
                </span>
                {f.kind === 'public' && <Badge tone="pine">全员</Badge>}
                {f.departmentKey && f.departmentKey === q.data.myDepartment && <Badge tone="lake">本部门</Badge>}
                {!f.active && <Badge>已停用</Badge>}
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function FolderPage({ folderId }: { folderId: number }) {
  const folders = useTrainingFolders();
  const q = useTrainingFiles(folderId);
  const folder = folders.data?.folders.find((f) => f.id === folderId);
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader title={folder?.name ?? '知识库'} subtitle="点一份文件就能看；看过的标「已看」" />
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-3 md:p-7">
        <div className="flex items-center justify-between gap-2">
          <h1 className="min-w-0 truncate text-[17px] font-bold text-ink md:hidden">{folder?.name ?? '知识库'}</h1>
          <Back to="/oa/training" label="全部文件夹" />
        </div>
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : q.isError && !q.data ? (
          <LoadFailed title="文件没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : q.data.length === 0 ? (
          <EmptyState title="这个文件夹里还没有文件" description="管理员在后台「员工培训」上传以后，这里就能看到。" />
        ) : (
          <div className="space-y-2" data-testid="training-files">
            {q.data.map((f) => (
              <Link
                key={f.id}
                to={`/oa/training/${folderId}/${f.id}`}
                data-testid={`training-file-${f.id}`}
                className="tap relative flex items-center gap-3 rounded-lg border border-line bg-card p-3 hover:border-line-strong"
              >
                <FileText className="size-5 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-ink">{f.title}</span>
                  <span className="block truncate text-[12.5px] text-ink-3">
                    {trainingFormatLabel(f.current.mime)} · {fileSizeText(f.current.sizeBytes)} · 更新于 {formatDateTime(f.current.createdAt)}
                  </span>
                </span>
                {f.myLastViewedAt ? <Badge tone="pine">已看</Badge> : <Badge tone="clay">未看</Badge>}
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function FilePage({ folderId, fileId }: { folderId: number; fileId: number }) {
  const q = useTrainingFiles(folderId);
  const file = q.data?.find((f) => f.id === fileId);
  return (
    <>
      <div className="max-md:hidden">
        <PageHeader title={file?.title ?? '知识库'} subtitle={file?.description || undefined} />
      </div>
      <div className="mx-auto w-full max-w-4xl space-y-3 p-3 md:p-7">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Back to={`/oa/training/${folderId}`} label="返回文件夹" />
        </div>
        {file && (
          <div className="md:hidden">
            <h1 className="break-words text-[17px] font-bold text-ink">{file.title}</h1>
            {file.description && <p className="mt-0.5 break-words text-[13px] text-ink-3">{file.description}</p>}
          </div>
        )}
        {q.isPending ? (
          <Skeleton className="h-60" />
        ) : q.isError && !q.data ? (
          <LoadFailed title="文件没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : !file ? (
          <EmptyState title="这份文件不在了" description="可能已经下架或挪到别的文件夹。" />
        ) : (
          <Card className="overflow-hidden p-3 md:p-5">
            <TrainingViewer file={file} />
          </Card>
        )}
      </div>
    </>
  );
}
