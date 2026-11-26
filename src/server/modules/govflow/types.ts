// 业财法各类事项的审批模板：通用事项在这里，其他类型由各自的模块通过 registerHooks 登记 template。

import { generalTemplate, type GfNode } from '@shared/govflow';
import { hooksOf, type DocRow } from './engine';

export function templateFor(doc: DocRow): GfNode[] {
  const fn = hooksOf(doc.docType).template;
  if (fn) return fn(doc);
  if (doc.docType !== 'general') throw new Error(`没有登记审批模板：${doc.docType}`);
  return generalTemplate({ amountCents: doc.amountCents ?? 0, contractLike: doc.payload.contractLike === true, flags: doc.flags });
}
