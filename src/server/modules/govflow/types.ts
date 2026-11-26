// 业财法各类事项的审批模板登记处：每批把自己的单据类型加进来（P01 只有「通用事项」，用来验引擎）。

import { generalTemplate, type GfDocType, type GfNode } from '@shared/govflow';
import type { DocRow } from './engine';

export type TemplateFn = (doc: DocRow) => GfNode[];

export const TEMPLATES: Record<GfDocType, TemplateFn> = {
  general: (doc) => generalTemplate({ amountCents: doc.amountCents ?? 0, contractLike: doc.payload.contractLike === true, flags: doc.flags }),
};

export function templateFor(doc: DocRow): GfNode[] {
  const fn = TEMPLATES[doc.docType as GfDocType];
  if (!fn) throw new Error(`没有登记审批模板：${doc.docType}`);
  return fn(doc);
}
