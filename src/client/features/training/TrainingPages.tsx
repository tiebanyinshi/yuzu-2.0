// 员工培训 · 员工端（「WCP → 员工培训」，docs/TRAINING.md）：文件夹 → 文件 → 在页面里看。
//   /oa/training                     看得到的文件夹（「培训资料」在最前，自己部门的标「本部门」）
//   /oa/training/<文件夹>            这个夹里的文件（看过的标「已看」）
//   /oa/training/<文件夹>/<文件>     看这份文件（PDF、图片、视频、Excel 页面里看，PPT、Word 下载）

import { Link, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, FileText, FolderOpen } from 'lucide-react';
import { fileSizeText } from '@shared/floorplans';
import { trainingFormatLabel, type TrainingFile, type TrainingFolderList } from '@shared/training';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Card, Skeleton } from '../../components/ui';
import { TrainingViewer } from './TrainingViewer';

export const trainingKeys = {
  folders: ['training', 'folders'] as const,
  files: (folderId: number) => ['training', 'files', folderId] as const,
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
  return (
    <>
      <PageHeader title="员工培训" subtitle="公司的培训资料和本部门的培训文件，手机上也能看" />
      <div className="mx-auto w-full max-w-3xl space-y-3 p-4 md:p-7">
        <Back to="/oa" label="WCP 首页" />
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : q.isError && !q.data ? (
          <LoadFailed title="文件夹没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="training-folders">
            {q.data.folders.map((f) => (
              <Link
                key={f.id}
                to={`/oa/training/${f.id}`}
                data-testid={`training-folder-${f.id}`}
                className="tap relative flex items-center gap-3 rounded-lg border border-line bg-card p-4 shadow-card hover:border-line-strong"
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
      <PageHeader title={folder?.name ?? '员工培训'} subtitle="点一份文件就能看；看过的标「已看」" />
      <div className="mx-auto w-full max-w-3xl space-y-3 p-4 md:p-7">
        <Back to="/oa/training" label="全部文件夹" />
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
                  <span className="text-[12.5px] text-ink-3">
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
      <PageHeader title={file?.title ?? '员工培训'} subtitle={file?.description || undefined} />
      <div className="mx-auto w-full max-w-4xl space-y-3 p-4 md:p-7">
        <Back to={`/oa/training/${folderId}`} label="返回文件夹" />
        {q.isPending ? (
          <Skeleton className="h-60" />
        ) : q.isError && !q.data ? (
          <LoadFailed title="文件没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
        ) : !file ? (
          <EmptyState title="这份文件不在了" description="可能已经下架或挪到别的文件夹。" />
        ) : (
          <Card className="p-3 md:p-5">
            <TrainingViewer file={file} />
          </Card>
        )}
      </div>
    </>
  );
}
