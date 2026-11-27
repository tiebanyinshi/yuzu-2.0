// 学习 Tab 的知识库（docs/STAFF_MP.md 第 2.3 节）：员工培训的文件夹与资料（主线 8.1.36，docs/TRAINING.md），接口原样挂在员工小程序端口上。
//   · 文档（PDF、Word、Excel、PPT）带令牌下载到手机，用微信自带的文档预览打开；
//   · 图片下载后放大看；视频、音频用短时地址播（<video>、音频播放器带不了请求头）；
//   · iPhone 放不了的格式（webm）写明「请在电脑上看」；
//   · 打开成功以后记「看过」（与 WCP 网页同一条记录，带着这一版的编号）。

import type { TrainingFile, TrainingFolder, TrainingFolderList, TrainingSearchItem } from '../../../src/shared/training';
import type { StaffMpMediaLink } from '../../../src/shared/staffmp';
import { absoluteUrl, call, download } from './api';
import { fileSize, shortTime } from './format';

export type OpenMode = 'document' | 'image' | 'video' | 'audio' | 'unsupported';

/** 微信文档预览认的类型 */
const DOC_TYPES = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];

export function extOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : '';
}

/** 这份资料在小程序里怎么打开（纯函数，单元测试核对） */
export function openModeOf(mime: string, fileName: string, platform = ''): { mode: OpenMode; note: string } {
  const ext = extOf(fileName);
  if (mime.startsWith('image/')) return { mode: 'image', note: '' };
  if (mime.startsWith('video/')) {
    if (ext === 'webm' && platform === 'ios') return { mode: 'unsupported', note: 'iPhone 放不了这种格式的视频（webm），请在电脑上的 WCP 里看' };
    return { mode: 'video', note: '' };
  }
  if (mime.startsWith('audio/')) return { mode: 'audio', note: '' };
  if (DOC_TYPES.includes(ext)) return { mode: 'document', note: '' };
  return { mode: 'unsupported', note: '这种文件小程序里打不开，请在电脑上的 WCP 里看' };
}

/** 没看过这一版（没看过，或者看过以后换了新版本）算「新」 */
export function isNew(file: Pick<TrainingFile, 'myLastViewedAt' | 'current'>): boolean {
  if (!file.myLastViewedAt) return true;
  return Date.parse(file.myLastViewedAt) < Date.parse(file.current.createdAt);
}

const KIND_LABELS: Record<OpenMode, string> = { document: '文档', image: '图片', video: '视频', audio: '音频', unsupported: '文件' };
const KIND_ICONS: Record<OpenMode, string> = { document: 'doc', image: 'image', video: 'video', audio: 'audio', unsupported: 'doc' };

export interface FileRow {
  id: number;
  folderId: number;
  title: string;
  meta: string;
  icon: string;
  isNew: boolean;
}

/** 列表里一行：标题、「PDF · 1.2 MB · 11-20 更新」、图标、新不新 */
export function fileRow(f: TrainingFile, folderName = ''): FileRow {
  const { mode } = openModeOf(f.current.mime, f.current.fileName);
  const ext = extOf(f.current.fileName).toUpperCase();
  const parts = [folderName, ext || KIND_LABELS[mode], fileSize(f.current.sizeBytes), `${shortTime(f.current.createdAt)} 更新`].filter(Boolean);
  return { id: f.id, folderId: f.folderId, title: f.title, meta: parts.join(' · '), icon: KIND_ICONS[mode], isNew: isNew(f) };
}

export interface FolderRow {
  id: number;
  name: string;
  meta: string;
  mine: boolean;
}

/** 文件夹按「培训资料」在前、本部门其次、其余照后台的顺序；空的不列（纯函数） */
export function folderRows(list: TrainingFolderList): FolderRow[] {
  const visible = list.folders.filter((f) => f.active && f.fileCount > 0);
  const rank = (f: TrainingFolder) => (f.kind === 'public' ? 0 : f.departmentKey && f.departmentKey === list.myDepartment ? 1 : 2);
  return visible
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.sort - b.sort || a.id - b.id)
    .map((f) => ({ id: f.id, name: f.name, meta: `${f.fileCount} 份资料`, mine: rank(f) === 1 }));
}

// ── 接口 ──

// ── 这一次打开小程序里真打开过、真放出来过的资料（学堂的文件课时要看过才能点「学完了」） ──

const openedAt: Record<number, number> = {};

/** 文件页：文档打开了、图片看了、视频音频放出来了 */
export function noteOpened(fileId: number, at: number = Date.now()): void {
  openedAt[fileId] = at;
}

/** 从 since 起真打开过这份资料没有 */
export function openedSince(fileId: number, since: number): boolean {
  return (openedAt[fileId] ?? 0) >= since;
}

export const loadFolders = () => call<TrainingFolderList>('GET', '/training/folders');
export const loadFiles = (folderId: number) => call<TrainingFile[]>('GET', `/training/folders/${folderId}/files`);
export const searchFiles = (q: string) => call<TrainingSearchItem[]>('GET', `/training/search?q=${encodeURIComponent(q)}`);

/** 记看过（带着这一版：管理员刚换了新版本的，门店系统会说换了，页面重新打开） */
export const markViewed = (file: TrainingFile) => call<{ ok: true }>('POST', `/training/files/${file.id}/viewed`, { versionId: file.current.id });

/** 文档、图片：带令牌下载到手机 */
export const downloadFile = (file: TrainingFile, onProgress?: (p: number) => void) => download(`/training/files/${file.id}/content?v=${file.current.id}`, onProgress);

/** 视频、音频：要一个短时地址（10 分钟有效） */
export async function mediaUrl(file: TrainingFile): Promise<string> {
  const link = await call<StaffMpMediaLink>('POST', '/media', { kind: 'training', id: file.id, v: file.current.id });
  return absoluteUrl(link.url);
}

// ── 最近搜过的（本机，留 5 条） ──

const RECENT_KEY = 'wcp_learn_recent';

export function recentSearches(): string[] {
  try {
    const v = wx.getStorageSync(RECENT_KEY) as string[] | '';
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** 把这次搜的放到最前面，去重，最多 5 条（纯函数） */
export function pushRecent(list: readonly string[], q: string): string[] {
  const t = q.trim();
  if (!t) return list.slice(0, 5);
  return [t, ...list.filter((x) => x !== t)].slice(0, 5);
}

export function rememberSearch(q: string): void {
  try {
    wx.setStorageSync(RECENT_KEY, pushRecent(recentSearches(), q));
  } catch {
    // 存不了就不记
  }
}
