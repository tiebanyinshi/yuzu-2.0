// 员工培训：一份文件在页面里怎么看（docs/TRAINING.md 第 4 节）。
//   · PDF：pdf.js 一页页画成图（手机浏览器也能看；按需取内容，大文件不用整份下完才开始看）；
//   · 图片、视频、音频：直接显示 / 播放（视频支持拖动进度）；
//   · Excel（.xlsx）：服务端读成表格，按工作表切换；
//   · PPT、Word 等：下载后用手机 / 电脑自带的软件看。
// 打开就记一次「看过」。

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { fileSizeText } from '@shared/floorplans';
import { trainingFormatLabel, type TrainingFile, type TrainingSheetBook } from '@shared/training';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Button, Notice, Skeleton } from '../../components/ui';

export const contentUrl = (fileId: number, opts: { download?: boolean; versionId?: number } = {}) => {
  const q = new URLSearchParams();
  if (opts.versionId) q.set('v', String(opts.versionId));
  if (opts.download) q.set('download', '1');
  const s = q.toString();
  return `/api/training/files/${fileId}/content${s ? `?${s}` : ''}`;
};

export function DownloadButton({ file, versionId, label = '下载' }: { file: TrainingFile; versionId?: number; label?: string }) {
  return (
    <a
      href={contentUrl(file.id, { download: true, versionId: versionId ?? file.current.id })}
      download={file.current.fileName}
      className="tap relative inline-flex h-10 items-center gap-2 rounded-full border border-line bg-card px-4 text-[14px] font-semibold text-ink-2 hover:border-line-strong"
      data-testid="training-download"
    >
      <Download className="size-4" />
      {label}
    </a>
  );
}

/** 一份培训文件的内容；recordView=false 时不记「看过」（后台预览用） */
export function TrainingViewer({ file, recordView = true }: { file: TrainingFile; recordView?: boolean }) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!recordView) return;
    // 记上「看过」以后刷新这个文件夹的清单（回去就是「已看」）；记不上不打扰员工
    void api
      .post(`/api/training/files/${file.id}/viewed`, { versionId: file.current.id })
      .then(() => qc.invalidateQueries({ queryKey: ['training', 'files', file.folderId] }))
      .catch(() => {});
  }, [file.id, file.current.id, file.folderId, recordView, qc]);
  const v = file.current;
  // 内容地址都带上看的这一版：分段读（PDF、视频拖动）时管理员换了新版本，也不会拿到新版本的片段
  const url = contentUrl(file.id, { versionId: v.id });
  return (
    <div className="space-y-3" data-testid="training-viewer" data-kind={file.viewKind}>
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink-3">
        <span>
          {trainingFormatLabel(v.mime)} · {fileSizeText(v.sizeBytes)} · 第 {v.versionNo} 版
        </span>
        <span className="flex-1" />
        <DownloadButton file={file} />
      </div>
      {file.viewKind === 'pdf' && <PdfPages url={url} />}
      {file.viewKind === 'image' && <img src={url} alt={file.title} className="mx-auto max-h-[80dvh] max-w-full rounded-lg border border-line" />}
      {file.viewKind === 'video' && <video src={url} controls playsInline preload="metadata" className="max-h-[80dvh] w-full rounded-lg bg-black" data-testid="training-video" />}
      {file.viewKind === 'audio' && <audio src={url} controls className="w-full" />}
      {file.viewKind === 'sheet' && <SheetView fileId={file.id} />}
      {file.viewKind === 'download' && (
        <Notice tone="info" title={`${trainingFormatLabel(v.mime)} 文件请下载后查看`}>
          点上面的「下载」，用手机或电脑自带的软件打开。想在页面里直接看，可以请管理员再传一份「另存为 PDF」的版本。
        </Notice>
      )}
    </div>
  );
}

/** PDF：一页页画成图；页数多的先画前几页，滚到再画后面的 */
function PdfPages({ url }: { url: string }) {
  const [pages, setPages] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef<import('pdfjs-dist').PDFDocumentProxy | null>(null);
  useEffect(() => {
    let cancelled = false;
    let task: import('pdfjs-dist').PDFDocumentLoadingTask | null = null;
    setPages(null);
    setError(null);
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        task = pdfjs.getDocument({ url, withCredentials: true, disableAutoFetch: true });
        const doc = await task.promise;
        if (cancelled) return void doc.cleanup();
        docRef.current = doc;
        setPages(doc.numPages);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
      docRef.current = null;
    };
  }, [url]);
  if (error)
    return (
      <Notice tone="error" title={`PDF 打不开：${error}`}>
        可以点「下载」用手机自带的软件看。
      </Notice>
    );
  if (pages === null) return <Skeleton className="h-[60dvh]" />;
  return (
    <div className="space-y-3" data-testid="training-pdf" data-pages={pages}>
      {Array.from({ length: pages }, (_, i) => (
        <PdfPage key={i} docRef={docRef} pageNo={i + 1} />
      ))}
    </div>
  );
}

function PdfPage({ docRef, pageNo }: { docRef: React.RefObject<import('pdfjs-dist').PDFDocumentProxy | null>; pageNo: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState(pageNo <= 2);
  const [drawn, setDrawn] = useState(false);
  // 滚到附近才画
  useEffect(() => {
    if (shown || !holder.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown(true), { rootMargin: '600px' });
    io.observe(holder.current);
    return () => io.disconnect();
  }, [shown]);
  useEffect(() => {
    if (!shown || drawn) return;
    let cancelled = false;
    void (async () => {
      const doc = docRef.current;
      const el = canvas.current;
      if (!doc || !el) return;
      const page = await doc.getPage(pageNo);
      const width = holder.current?.clientWidth || 800;
      const base = page.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (width / base.width) * ratio });
      el.width = Math.round(viewport.width);
      el.height = Math.round(viewport.height);
      const g = el.getContext('2d');
      if (!g || cancelled) return;
      await page.render({ canvas: el, canvasContext: g, viewport }).promise;
      if (!cancelled) setDrawn(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [shown, drawn, docRef, pageNo]);
  return (
    <div ref={holder} className="relative overflow-hidden rounded-lg border border-line bg-white" data-testid={`training-pdf-page-${pageNo}`} data-drawn={drawn}>
      <canvas ref={canvas} className={cn('block w-full', !drawn && 'h-[60dvh]')} aria-label={`第 ${pageNo} 页`} />
      <span className="absolute right-2 bottom-2 rounded bg-ink/60 px-1.5 text-[12px] text-paper">{pageNo}</span>
    </div>
  );
}

/** Excel：服务端读成表格，按工作表切换 */
function SheetView({ fileId }: { fileId: number }) {
  const q = useQuery({ queryKey: ['training', 'sheet', fileId], queryFn: () => api.get<TrainingSheetBook>(`/api/training/files/${fileId}/sheet`) });
  const [tab, setTab] = useState(0);
  if (q.isPending) return <Skeleton className="h-60" />;
  if (q.isError && !q.data) return <LoadFailed title={errorMessage(q.error)} onRetry={() => q.refetch()} retrying={q.isFetching} />;
  const sheet = q.data.sheets[tab] ?? q.data.sheets[0];
  if (!sheet) return <Notice tone="info" title="这份 Excel 里没有内容" />;
  // 合并单元格：左上角那格占几行几列，其余的不画
  const covered = new Set<string>();
  const span = new Map<string, { rows: number; cols: number }>();
  for (const m of sheet.merges) {
    span.set(`${m.r1}:${m.c1}`, { rows: m.r2 - m.r1 + 1, cols: m.c2 - m.c1 + 1 });
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(`${r}:${c}`);
  }
  return (
    <div className="space-y-2" data-testid="training-sheet">
      {q.data.sheets.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="工作表">
          {q.data.sheets.map((s, i) => (
            <Button key={s.name} size="sm" variant={i === tab ? 'primary' : 'secondary'} onClick={() => setTab(i)} role="tab" aria-selected={i === tab}>
              {s.name}
            </Button>
          ))}
        </div>
      )}
      {/* 用网格排单元格（合并的格子跨行跨列），不手写表格 */}
      <div className="max-h-[75dvh] overflow-auto rounded-lg border border-line bg-card">
        <div className="grid w-max text-[13px]" style={{ gridTemplateColumns: `repeat(${sheet.rows[0]?.length ?? 1}, minmax(5rem, max-content))` }}>
          {sheet.rows.flatMap((row, r) =>
            row.map((cell, c) => {
              const k = `${r + 1}:${c}`;
              if (covered.has(k)) return null;
              const sp = span.get(k);
              return (
                <div
                  key={k}
                  style={{ gridRow: `${r + 1} / span ${sp?.rows ?? 1}`, gridColumn: `${c + 1} / span ${sp?.cols ?? 1}` }}
                  className={cn('max-w-[28rem] border-r border-b border-line px-2 py-1 whitespace-pre-wrap', r === 0 && 'bg-paper-2 font-semibold')}
                >
                  {cell}
                </div>
              );
            }),
          )}
        </div>
      </div>
      {sheet.truncated && <p className="text-[12.5px] text-ink-3">表格太大，页面里只显示前 500 行、40 列；完整的请下载查看。</p>}
    </div>
  );
}
