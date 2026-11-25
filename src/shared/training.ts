// 员工培训（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC33）：文件夹、培训文件与版本、谁看过。

/** 一份文件最大 200 MB（PC33 待确认） */
export const TRAINING_MAX_BYTES = 200 * 1024 * 1024;
/** 分块上传每块的大小（原始字节；base64 以后约 4 MB，接口的请求体上限按它定） */
export const TRAINING_CHUNK_BYTES = 3 * 1024 * 1024;
export const TRAINING_MAX_CHUNKS = Math.ceil(TRAINING_MAX_BYTES / TRAINING_CHUNK_BYTES);

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
