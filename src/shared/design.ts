// Design 素材库（店主 2026-11-24，docs/BOARDS.md 第 4、9 节）：字体、图片、视频存在素材库里，每个「用途」选一份当前使用的，一键切换、可切回。

export type DesignAssetKind = 'font' | 'image' | 'video';
export const DESIGN_KIND_LABELS: Record<DesignAssetKind, string> = { font: '字体', image: '图片', video: '视频' };

/** 每种素材的上限（字节）与收哪些格式（按文件头认） */
export const DESIGN_LIMITS: Record<DesignAssetKind, { maxBytes: number; formats: string }> = {
  font: { maxBytes: 8 * 1024 * 1024, formats: 'WOFF2、WOFF、OTF、TTF' },
  image: { maxBytes: 5 * 1024 * 1024, formats: 'PNG、JPG、WebP、SVG（不含脚本）' },
  video: { maxBytes: 30 * 1024 * 1024, formats: 'MP4（H.264）、WebM' },
};

/** 素材库一共能存多少（所有素材的所有版本，归档的也算；Codex 安全审查）：文件存在数据库里，跟着每份备份走，不让它无限长 */
export const DESIGN_TOTAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** 素材库一共能有多少个版本（Codex 安全审查：只限字节的话，几十字节的小文件可以存上亿条，每条都有素材、版本、日志行） */
export const DESIGN_TOTAL_MAX_VERSIONS = 20_000;
/**
 * 每人一共能占多少（这个人传的所有版本，归档的也算；Codex 安全审查）：总量的四分之一，一个人传满了别人照样能传。
 * 素材只追加、没有删除的办法，腾空间（永久删旧版本）待店主定（docs/BOARDS.md 第 4 节）
 */
export const DESIGN_STAFF_MAX_BYTES = 512 * 1024 * 1024;
/** 每人每 24 小时最多存多少个新版本（重传同一个文件不算；设计师正常一天用不到这么多） */
export const DESIGN_DAILY_VERSIONS_PER_STAFF = 300;

/**
 * 用途：系统里登记好的「这个位置用哪份素材」。每个用途限定一种素材；没设（或切成「不用素材」）时照原来的样子。
 * 新加用途在这里加一行，再在用到的地方读它（docs/BOARDS.md 第 4 节）。
 */
export const DESIGN_SLOTS = {
  'emenu.font.en': { kind: 'font', label: '平板菜单 · 英文品牌字体', where: '餐桌平板电子菜单的英文标题；没设时读服务器 brand-fonts 目录，再没有用顶替字体' },
  'portal.banner': { kind: 'image', label: '门户页 · 顶部横幅', where: '登录后门户页欢迎语上方的一张横幅图（建议 2400 × 600）；没设时不显示' },
  'guide.screen.video': { kind: 'video', label: '门店大屏 · 待机视频', where: '对客导览大屏还没有楼层图时循环播放（静音）；没设时显示「对客导览」' },
} as const satisfies Record<string, { kind: DesignAssetKind; label: string; where: string }>;
export type DesignSlot = keyof typeof DESIGN_SLOTS;
export const DESIGN_SLOT_KEYS = Object.keys(DESIGN_SLOTS) as DesignSlot[];

export interface DesignVersion {
  id: number;
  versionNo: number;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  fontFamily: string | null;
  createdAt: string;
  createdByName: string;
}

export interface DesignAsset {
  id: number;
  kind: DesignAssetKind;
  name: string;
  tags: string[];
  /** 说明（字体写授权说明） */
  note: string;
  archived: boolean;
  latest: DesignVersion;
  versionCount: number;
  /** 用在哪些用途上（用着的是哪一版） */
  usedBy: { slot: DesignSlot; versionId: number }[];
  createdAt: string;
  updatedAt: string;
}

export interface DesignAssetDetail extends DesignAsset {
  versions: DesignVersion[];
}

export interface DesignSlotState {
  slot: DesignSlot;
  kind: DesignAssetKind;
  label: string;
  where: string;
  /** 现在用的（没设、切成不用素材的为空） */
  current: { versionId: number; assetId: number; assetName: string; versionNo: number; mime: string } | null;
  /** 最近一次切换：谁、什么时候（从来没切过的为空） */
  changedAt: string | null;
  changedByName: string | null;
  /** 素材出了更新的版本：用途不会自己跟着换，这里提示 */
  newerVersionId: number | null;
  /** 切换记录（最近的在前，最多 10 条） */
  history: { id: number; versionId: number | null; assetName: string | null; versionNo: number | null; reason: string; at: string; byName: string }[];
}

/** 各处读的「现在用哪一版」：用途 → 版本编号（没设为空）；文件地址 designFileUrl(id) */
export type DesignCurrent = Record<DesignSlot, number | null>;
export const designFileUrl = (versionId: number) => `/api/design/files/${versionId}`;
