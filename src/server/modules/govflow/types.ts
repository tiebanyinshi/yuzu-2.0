// 业财法各类事项的审批模板：通用事项在这里，其他类型由各自的模块通过 registerHooks 登记 template。
// 8.2.15：店主在「流程与阈值」里给这类事项存了自己的流程的，用店主的（再追加 fixedNodes，例如零星采购超额的合并特批）；没存或清除了的用内置的。

import { generalTemplate, type GfNode } from '@shared/govflow';
import type { Db } from '../../db';
import { activeFlowConfig, hooksOf, type DocRow, type FlowConfigRow } from './engine';

/** 代码里的内置流程 */
export async function builtinTemplate(db: Db, doc: DocRow): Promise<GfNode[]> {
  const fn = hooksOf(doc.docType).template;
  if (fn) return fn(doc, db);
  if (doc.docType !== 'general') throw new Error(`没有登记审批模板：${doc.docType}`);
  return generalTemplate({ amountCents: doc.amountCents ?? 0, contractLike: doc.payload.contractLike === true, flags: doc.flags });
}

/** 这张单提交时用的模板，以及用的是哪一版（空 = 内置） */
export async function resolveTemplate(db: Db, doc: DocRow): Promise<{ nodes: GfNode[]; config: FlowConfigRow | null }> {
  const config = await activeFlowConfig(db, doc.docType);
  if (!config?.nodes) return { nodes: await builtinTemplate(db, doc), config };
  return { nodes: [...config.nodes, ...(hooksOf(doc.docType).fixedNodes?.(doc) ?? [])], config };
}

export async function templateFor(db: Db, doc: DocRow): Promise<GfNode[]> {
  return (await resolveTemplate(db, doc)).nodes;
}
