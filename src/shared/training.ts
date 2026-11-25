// 员工培训（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC37）：文件夹、培训文件与版本、谁看过。

/** 一份文件最大 200 MB（PC37 待确认） */
export const TRAINING_MAX_BYTES = 200 * 1024 * 1024;
/** 分块上传每块的大小（原始字节；base64 以后约 4 MB，接口的请求体上限按它定） */
export const TRAINING_CHUNK_BYTES = 3 * 1024 * 1024;
export const TRAINING_MAX_CHUNKS = Math.ceil(TRAINING_MAX_BYTES / TRAINING_CHUNK_BYTES);
/**
 * 存储上限（Codex 安全审查 ec38502，PC37 待确认）：培训文件内容一共最多 20 GB、版本最多 5000 个；
 * 每人同时最多 5 个没传完的上传、没传完的一共 1 GB；每人 24 小时内最多开始 100 次上传
 */
export const TRAINING_TOTAL_MAX_BYTES = 20 * 1024 * 1024 * 1024;
export const TRAINING_TOTAL_MAX_VERSIONS = 5000;
export const TRAINING_OPEN_UPLOADS_PER_STAFF = 5;
export const TRAINING_OPEN_BYTES_PER_STAFF = 1024 * 1024 * 1024;
export const TRAINING_DAILY_UPLOADS_PER_STAFF = 100;

export type TrainingFolderKind = 'public' | 'department';

export interface TrainingFolder {
  id: number;
  name: string;
  kind: TrainingFolderKind;
  /** 对应的部门（org_departments.key）；自己新建的部门文件夹为空（所有员工都看得到） */
  departmentKey: string | null;
  sort: number;
  active: boolean;
  version: number;
  /** 上架的文件数 */
  fileCount: number;
}

export interface TrainingFolderList {
  folders: TrainingFolder[];
  /** 我岗位所在的部门（没有岗位的为空） */
  myDepartment: string | null;
  /** 能管理（看得到全部文件夹、停用的与下架的） */
  canManage: boolean;
}

/** 页面里怎么看：PDF、图片、视频、音频、Excel 页面里直接看，其余下载 */
export type TrainingViewKind = 'pdf' | 'image' | 'video' | 'audio' | 'sheet' | 'download';

export interface TrainingFileVersion {
  id: number;
  versionNo: number;
  fileName: string;
  mime: string;
  sizeBytes: number;
  note: string;
  uploadedByName: string;
  createdAt: string;
}

export interface TrainingFile {
  id: number;
  folderId: number;
  title: string;
  description: string;
  active: boolean;
  sort: number;
  version: number;
  current: TrainingFileVersion;
  viewKind: TrainingViewKind;
  /** 我最近一次看是什么时候（没看过为空） */
  myLastViewedAt: string | null;
  /** 有管理权限时：看过的人数 */
  viewerCount?: number;
  updatedAt: string;
}

export interface TrainingViewer {
  staffId: number;
  name: string;
  department: string | null;
  firstViewedAt: string;
  lastViewedAt: string;
  viewCount: number;
  versionNo: number | null;
}

export interface TrainingFileDetail {
  file: TrainingFile;
  versions: TrainingFileVersion[];
  viewers: TrainingViewer[];
}

/** 能上传的格式：类型 → 扩展名、页面里怎么看 */
export const TRAINING_FORMATS: Record<string, { ext: string[]; view: TrainingViewKind; label: string }> = {
  'application/pdf': { ext: ['pdf'], view: 'pdf', label: 'PDF' },
  'image/jpeg': { ext: ['jpg', 'jpeg'], view: 'image', label: '图片' },
  'image/png': { ext: ['png'], view: 'image', label: '图片' },
  'image/webp': { ext: ['webp'], view: 'image', label: '图片' },
  'image/gif': { ext: ['gif'], view: 'image', label: '图片' },
  'video/mp4': { ext: ['mp4', 'm4v'], view: 'video', label: '视频' },
  'video/webm': { ext: ['webm'], view: 'video', label: '视频' },
  'video/quicktime': { ext: ['mov'], view: 'video', label: '视频' },
  'audio/mpeg': { ext: ['mp3'], view: 'audio', label: '音频' },
  'audio/mp4': { ext: ['m4a'], view: 'audio', label: '音频' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: ['xlsx'], view: 'sheet', label: 'Excel' },
  'application/vnd.ms-excel': { ext: ['xls'], view: 'download', label: 'Excel' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: ['pptx'], view: 'download', label: 'PPT' },
  'application/vnd.ms-powerpoint': { ext: ['ppt'], view: 'download', label: 'PPT' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: ['docx'], view: 'download', label: 'Word' },
  'application/msword': { ext: ['doc'], view: 'download', label: 'Word' },
};

/** 按文件名认类型（浏览器给的类型常常为空或不准，以扩展名为准）；认不出返回 null */
export function trainingMimeOf(fileName: string): string | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  for (const [mime, f] of Object.entries(TRAINING_FORMATS)) if (f.ext.includes(ext)) return mime;
  return null;
}

export const trainingViewKind = (mime: string): TrainingViewKind => TRAINING_FORMATS[mime]?.view ?? 'download';
export const trainingFormatLabel = (mime: string): string => TRAINING_FORMATS[mime]?.label ?? '文件';

export const TRAINING_ACCEPT = Object.values(TRAINING_FORMATS)
  .flatMap((f) => f.ext.map((e) => `.${e}`))
  .join(',');

/** Excel 在页面里看：每张表的单元格文字（行从第 1 行起），合并单元格（行从 1 起、列从 0 起） */
export interface TrainingSheetBook {
  sheets: { name: string; rows: string[][]; merges: { r1: number; c1: number; r2: number; c2: number }[]; truncated: boolean }[];
}

/** PDF 一页画成多大（Codex 安全审查 04eb112）：一页画布最多 800 万像素、一条边最多 8192 像素，超了等比缩小，不跟着 PDF 里写的页面比例无限放大 */
export const TRAINING_PDF_MAX_PIXELS = 8_000_000;
export const TRAINING_PDF_MAX_SIDE = 8192;
/** 按页面原始宽高、显示宽度与屏幕像素比算出画 PDF 用的缩放倍数 */
export function pdfRenderScale(pageWidth: number, pageHeight: number, displayWidth: number, pixelRatio: number): number {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return 0;
  const want = (Math.max(displayWidth, 1) / pageWidth) * Math.min(Math.max(pixelRatio, 1), 2);
  const w = pageWidth * want;
  const h = pageHeight * want;
  const shrink = Math.min(1, Math.sqrt(TRAINING_PDF_MAX_PIXELS / (w * h)), TRAINING_PDF_MAX_SIDE / w, TRAINING_PDF_MAX_SIDE / h);
  return want * shrink;
}

/** 培训文件名最多几个字（服务端校验与页面先查同一条，Codex 审查 9b1dd16） */
export const TRAINING_FILE_NAME_MAX = 200;
/** 文件名哪里不行（去掉首尾空白以后看）；没问题返回 null */
export function trainingFileNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return '缺少文件名';
  if (n.length > TRAINING_FILE_NAME_MAX) return `文件名最多 ${TRAINING_FILE_NAME_MAX} 个字`;
  if (/[\\/\u0000-\u001f]/.test(n)) return '文件名不能带路径或控制字符';
  return null;
}

/** 培训图片在页面里直接显示：一张最多 4000 万像素、一条边最多 16384 像素（Codex 安全审查 9b1dd16） */
export const TRAINING_IMAGE_MAX_PIXELS = 40_000_000;
export const TRAINING_IMAGE_MAX_SIDE = 16384;

/** PDF 内嵌图片像素上限（Codex 安全审查 bfc32cd）：前端 PDF.js 预览与服务端上传完成共用，单张最多 1600 万像素（约 400 DPI A4）、一条边最多 16384 */
export const TRAINING_PDF_MAX_IMAGE_PIXELS = 16_000_000;
export const TRAINING_PDF_MAX_IMAGE_SIDE = 16384;

/**
 * 分块上传操作编号（UUIDv7，内嵌毫秒时间戳；Codex 审查 bfc32cd）：
 *   · 编号有效期 7 天（允许客户端时钟最多超前 24 小时）；
 *   · 「不传了」的作废记录保留 10 天（大于 7 天 + 24 小时），定时清理删掉作废记录时，对应的编号早已过期，永远不能重新打开为 open。
 */
export const TRAINING_UPLOAD_KEY_TTL_DAYS = 7;
export const TRAINING_UPLOAD_KEY_FUTURE_MS = 24 * 60 * 60 * 1000;
export const TRAINING_CANCELLED_KEEP_DAYS = 10;

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 生成带时间戳的上传操作编号（RFC 9562 UUIDv7；内网 HTTP 浏览器也能用） */
export function newTrainingUploadKey(nowMs = Date.now()): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  const t = Math.max(0, Math.floor(nowMs));
  // 前 48 位：大端毫秒时间戳（避免 32 位位运算溢出，用除法取高 16 位）
  const hi = Math.floor(t / 0x100000000);
  const lo = t >>> 0;
  bytes[0] = (hi >>> 8) & 0xff;
  bytes[1] = hi & 0xff;
  bytes[2] = (lo >>> 24) & 0xff;
  bytes[3] = (lo >>> 16) & 0xff;
  bytes[4] = (lo >>> 8) & 0xff;
  bytes[5] = lo & 0xff;
  // version = 7 (0111), variant = RFC 4122/9562 (10xx)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 从 UUIDv7 上传编号里取出毫秒时间戳；不是合法 UUIDv7 返回 null */
export function trainingUploadKeyTime(key: string): number | null {
  if (!UUID_V7_RE.test(key)) return null;
  const hex = key.slice(0, 8) + key.slice(9, 13);
  const ms = Number.parseInt(hex, 16);
  return Number.isSafeInteger(ms) ? ms : null;
}

export type TrainingUploadKeyState = 'valid' | 'expired' | 'future' | 'invalid';

/** 判断一个上传操作编号在 nowMs 时刻的状态 */
export function trainingUploadKeyState(key: string, nowMs: number): TrainingUploadKeyState {
  const t = trainingUploadKeyTime(key);
  if (t === null) return 'invalid';
  if (nowMs - t > TRAINING_UPLOAD_KEY_TTL_DAYS * 86_400_000) return 'expired';
  if (t - nowMs > TRAINING_UPLOAD_KEY_FUTURE_MS) return 'future';
  return 'valid';
}
