// 员工培训的分块上传（docs/TRAINING.md 第 5 节）：开始（带操作编号）→ 一块块传（已在服务器上的块跳过）→ 完成。
// 同一个操作编号重新来一遍就是「接着传」：开始返回已经传到的块，完成对同一次上传只登记一次。
// 没收到「完成」的结果时先查回这次上传（GET uploads/:id）：已经登记了就当成功，不会再建一份。
// 发请求以前先把操作编号、文件名大小和传到哪里（文件夹 / 哪份文件的新版本）存进本机并读回核对，存不了就不传；
// 有了结论（登记好了）才删。刷新、离开页面以后「WCP 设置 → 员工培训」顶上列出没确认的，用原编号、原目标查回或接着传（Codex 审查 e1d8be3）。

import { useSyncExternalStore } from 'react';
import { TRAINING_CHUNK_BYTES, trainingMimeOf } from '@shared/training';
import { api, isRejected, UncertainError } from '../../lib/api';
import { bytesToBase64 } from '../../lib/import-file';

export interface UploadTarget {
  folderId?: number;
  fileId?: number;
  title?: string;
  description?: string;
  note?: string;
}

/** 本机记着的、还没确认登记好的上传 */
export interface PendingUpload {
  key: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  target: UploadTarget;
  /** 列表里显示：传到哪个文件夹 / 哪份文件 */
  targetLabel: string;
  createdAt: string;
}

const STORE = 'yuzu.trainingUploads.v1';
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedList: PendingUpload[] = [];

function readAll(): PendingUpload[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORE);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as PendingUpload[]) : [];
    cachedList = Array.isArray(parsed) ? parsed : [];
  } catch {
    cachedList = [];
  }
  return cachedList;
}

function persist(list: PendingUpload[]): boolean {
  const raw = list.length ? JSON.stringify(list) : null;
  try {
    if (raw === null) localStorage.removeItem(STORE);
    else localStorage.setItem(STORE, raw);
    return localStorage.getItem(STORE) === raw;
  } catch {
    return false;
  } finally {
    listeners.forEach((l) => l());
  }
}

/** 存进本机并读回核对；已经有同一个编号的不动（原目标不变） */
function savePendingUpload(p: PendingUpload): boolean {
  const list = readAll();
  if (list.some((x) => x.key === p.key)) return true;
  return persist([...list, p]);
}

export function removePendingUpload(key: string) {
  const list = readAll();
  if (list.some((x) => x.key === key)) persist(list.filter((x) => x.key !== key));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => e.key === STORE && l();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
};

/** 页面上正由某一行（上传进度、新版本）处理的编号：顶上「没确认的上传」不重复列 */
const claimed = new Set<string>();
let claimedVer = 0;
let snap: { raw: string | null | undefined; ver: number; list: PendingUpload[] } = { raw: undefined, ver: -1, list: [] };

export function setUploadClaimed(key: string, on: boolean) {
  if (on === claimed.has(key)) return;
  if (on) claimed.add(key);
  else claimed.delete(key);
  claimedVer += 1;
  listeners.forEach((l) => l());
}

function unclaimed(): PendingUpload[] {
  const all = readAll();
  if (snap.raw !== cachedRaw || snap.ver !== claimedVer) snap = { raw: cachedRaw, ver: claimedVer, list: all.filter((p) => !claimed.has(p.key)) };
  return snap.list;
}

export function usePendingUploads(): PendingUpload[] {
  return useSyncExternalStore(subscribe, unclaimed, () => snap.list);
}

/** 查回一次没确认的上传（用原编号、原参数重新「开始」，服务端只回状态、不改东西）：登记好了就删掉本机记录 */
export async function checkPendingUpload(p: PendingUpload): Promise<'done' | 'open'> {
  const st = await api.post<UploadState>('/api/admin/training/uploads', { clientKey: p.key, fileName: p.fileName, mime: p.mime, sizeBytes: p.sizeBytes });
  if (st.status === 'done') removePendingUpload(p.key);
  return st.status;
}

interface UploadState {
  uploadId: number;
  chunkCount: number;
  received: number[];
  status: 'open' | 'done';
  fileId: number | null;
  versionId: number | null;
}

/**
 * 传一个文件；progress 0–1。clientKey 与 target 由调用方保管：失败了用同一个编号、同一个目标再调一次就是接着传。
 * 本机已经记着这个编号的，按记着的目标传（不按调用方这次给的）。
 */
export async function uploadTrainingFile(file: File, clientKey: string, target: UploadTarget, progress: (p: number) => void, targetLabel = ''): Promise<{ fileId: number; versionId: number }> {
  const mime = trainingMimeOf(file.name);
  if (!mime) throw new Error(`「${file.name}」的格式不支持：只能传 PDF、图片、视频、音频、Excel、PPT、Word`);
  const saved = readAll().find((x) => x.key === clientKey);
  if (saved && (saved.fileName !== file.name || saved.sizeBytes !== file.size)) throw new Error(`选的不是原来那个文件：请选「${saved.fileName}」`);
  if (saved) target = saved.target;
  else if (!savePendingUpload({ key: clientKey, fileName: file.name, mime, sizeBytes: file.size, target, targetLabel, createdAt: new Date().toISOString() }))
    throw new Error('本机浏览器保存不了上传记录（存储空间已满或被禁用），为防止重复登记，这份没有上传。请清理浏览器数据或换一台电脑。');
  const start = await api.post<UploadState>('/api/admin/training/uploads', { clientKey, fileName: file.name, mime, sizeBytes: file.size });
  if (start.status === 'done') {
    removePendingUpload(clientKey);
    progress(1);
    return { fileId: start.fileId!, versionId: start.versionId! };
  }
  const have = new Set(start.received);
  let done = have.size;
  for (let seq = 0; seq < start.chunkCount; seq++) {
    if (have.has(seq)) continue;
    const part = await file.slice(seq * TRAINING_CHUNK_BYTES, (seq + 1) * TRAINING_CHUNK_BYTES).arrayBuffer();
    // 一块传不上去先原样再试两次（同一块重传不会重复存）
    for (let attempt = 0; ; attempt++) {
      try {
        await api.put(`/api/admin/training/uploads/${start.uploadId}/chunks/${seq}`, { data: bytesToBase64(part) }, { timeoutMs: 120_000 });
        break;
      } catch (e) {
        if (attempt >= 2 || isRejected(e)) throw e;
      }
    }
    done += 1;
    progress((done / start.chunkCount) * 0.95);
  }
  const body = { folderId: target.folderId ?? null, fileId: target.fileId ?? null, title: target.title ?? '', description: target.description ?? '', note: target.note ?? '' };
  try {
    const r = await api.post<{ fileId: number; versionId: number }>(`/api/admin/training/uploads/${start.uploadId}/complete`, body, { timeoutMs: 180_000 });
    removePendingUpload(clientKey);
    progress(1);
    return r;
  } catch (e) {
    if (!(e instanceof UncertainError)) throw e;
    // 没收到结果：查回这次上传，已经登记了就当成功
    const state = await api.get<UploadState>(`/api/admin/training/uploads/${start.uploadId}`);
    if (state.status === 'done') {
      removePendingUpload(clientKey);
      progress(1);
      return { fileId: state.fileId!, versionId: state.versionId! };
    }
    throw e;
  }
}
