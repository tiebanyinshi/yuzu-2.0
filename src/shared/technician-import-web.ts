// 网页导入技师的预览与结果（8.2.2，docs/V8222_TECHNICIANS.md 第 8 节；服务端 technician-import-web.ts）。

export interface TechnicianImportPreview {
  fileName: string;
  /** 表里的行数（有问题的也算） */
  total: number;
  create: number;
  update: number;
  same: number;
  groupsCreated: string[];
  groupsReactivated: string[];
  /** 有一处就一行都不导 */
  errors: { line: number; message: string }[];
  rows: {
    line: number;
    techNo: string;
    name: string;
    /** create 新建 / update 更新资料 / same 不变 */
    action: 'create' | 'update' | 'same';
    /** 要写的、要改的（手机号打码） */
    changes: string[];
    /** 与名册有出入、不改的（姓名、性别） */
    notes: string[];
  }[];
  /** 生效时原样带回：预览以后名册或文件变了就对不上 */
  planHash: string;
  applied: boolean;
}

export const TECH_IMPORT_ACTION_LABELS: Record<TechnicianImportPreview['rows'][number]['action'], string> = { create: '新建', update: '更新', same: '不变' };
