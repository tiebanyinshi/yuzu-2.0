// 点餐系统 · 平板电子菜单的接口（8.0.10，docs/EMENU.md 第 7 节）。
//   · 平板（要登录、要「打开平板点餐」）：菜单、按手牌找客人、核对桌号、下单、结果待确认的查回与作废、图片；
//   · 后台（「维护电子菜单」）：设置、分类、各页、菜品图文、图片上传、从价目表生成初稿；
//   · 点单密码：店主给人生成、收回（「管理员工账号」）；本人自己重新生成（要「餐饮点单」）。

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { guard, guardAny } from '../../auth/guard';
import { readSnapshot } from '../../db';
import { ctxOf, type Deps } from '../../lib/context';
import { csvReply } from '../../lib/csv';
import { notFound } from '../../lib/errors';
import { currentStoreId } from '../../lib/store-context';
import { idParam, parse } from '../../lib/validate';
import {
  createEmenuCategory,
  createEmenuDish,
  emenuAdmin,
  emenuEnglishCsv,
  generateEmenuDraft,
  importEmenuEnglish,
  saveEmenuPages,
  saveEmenuRules,
  updateEmenuCategory,
  updateEmenuDish,
} from './admin';
import { abandonEmenuOrder, checkEmenuTable, emenuGuest, emenuImage, emenuMenu, emenuOpLookup, placeEmenuOrder, saveEmenuImage } from './core';
import { clearOrderPin, orderPinStatus, resolveWaiter, setOrderPin } from './pins';
import { brandFontStatus, readBrandFont } from './fonts';
import type { BrandFontStatus } from '@shared/emenu-brand-font';
import { slotVersion } from '../design';

export function registerEmenuRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const tablet = guard('emenu.view');
  const manage = guard('emenu.manage');

  // ── 平板 ──
  // 维护电子菜单的人预览时也读这一份
  // 设计师在工作台点「预览 → 在这台电脑上打开」也读这一份（8.1.1，只读；按手牌找客人、下单照旧只给平板）
  // 8.1.17（BW3）：打开平板点餐的账号按自己的出品口下单权限标「请找服务员点」（后台预览、工作台不限）
  app.get('/api/emenu/menu', { preHandler: guardAny('emenu.view', 'emenu.manage', 'studio.edit') }, async (req) => readSnapshot(sql, (tx) => emenuMenu(tx, deps, undefined, req.actor)));
  app.get('/api/emenu/guest', { preHandler: tablet }, async (req) => emenuGuest(sql, req.query ?? {}));
  app.get('/api/emenu/table', { preHandler: tablet }, async (req) => checkEmenuTable(sql, req.query ?? {}));
  app.post('/api/emenu/orders', { preHandler: tablet }, async (req) => placeEmenuOrder(deps, req.body, req.actor, req.ip));
  // 离开电子菜单前核对一位点单的同事（8.1.15，TC5）：后台开了「点单密码」时，平板上的「返回工作台」「退出登录」先过这一步。
  // 与下单同一套密码、同一份限次（错多了锁，按这台平板登录的账号记）；只核对、不写业务数据
  app.post('/api/emenu/staff-check', { preHandler: tablet }, async (req) => {
    const waiter = await resolveWaiter(deps, (req.body as { pin?: unknown } | null)?.pin, req.actor, req.ip);
    return { ok: true, displayName: waiter.displayName };
  });
  app.get('/api/emenu/orders/by-key/:key', { preHandler: tablet }, async (req) => emenuOpLookup(sql, req.params));
  app.post('/api/emenu/orders/by-key/:key/abandon', { preHandler: tablet }, async (req) => abandonEmenuOrder(deps, req.params, req.body, req.actor, req.ip));
  // 图片的内容不会变（按内容去重、只追加）：浏览器长期缓存
  // 设计师在工作台里画菜单页也要看菜品图（8.1.1）
  app.get('/api/emenu/images/:id', { preHandler: guardAny('emenu.view', 'emenu.manage', 'studio.edit') }, async (req, reply) => {
    const img = await emenuImage(sql, parse(idParam, req.params).id);
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(img.data);
  });
  // 授权的品牌英文字体（8.1.5，PP4）：门店服务器的 brand-fonts 目录，只发给能打开菜单的账号；没放（或放的不能用）404，页面照旧用顶替的字体。
  // 2026-11-22（PD6）起 en.woff2、en.woff、en.otf、en.ttf 都认，地址改成不带格式的 /api/emenu/fonts/brand-en；旧地址 en.woff2 留着（还开着的旧页面照常取）。
  // 字体文件可能被换成新的：按文件名、修改时间与大小给 ETag，浏览器每次问一下、没变就 304
  // 店主 2026-11-24（docs/BOARDS.md 第 4 节）：Design 素材库的用途「平板菜单 · 英文品牌字体」设了就用它，没设照旧读 brand-fonts 目录
  // 素材库的字体（Codex 安全审查）：这里只按版本号给 ETag、没变 304，变了转到 /api/design/files/:id 取——
  // 那里有下载占位（全店、每人同时几个）与 1MB 一段的分段读，这个地址不把整份字体读进内存
  const brandFont = async (req: FastifyRequest, reply: FastifyReply) => {
    const slot = await slotVersion(deps.sql, 'emenu.font.en');
    if (slot) {
      const etag = `"design-${slot.versionId}"`;
      reply.header('cache-control', 'private, no-cache').header('etag', etag);
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply.redirect(`/api/design/files/${slot.versionId}`, 302);
    }
    const font = await readBrandFont(deps.config.brandFontPath);
    if (!font) throw notFound('门店服务器上还没有放能用的授权英文字体（brand-fonts/en.woff2 或 en.ttf 等），页面用顶替的字体');
    reply.header('cache-control', 'private, no-cache').header('etag', font.etag);
    if (req.headers['if-none-match'] === font.etag) return reply.code(304).send();
    return reply.header('content-type', font.mime).send(font.data);
  };
  const fontGuard = guardAny('emenu.view', 'emenu.manage', 'studio.edit');
  app.get('/api/emenu/fonts/brand-en', { preHandler: fontGuard }, brandFont);
  app.get('/api/emenu/fonts/en.woff2', { preHandler: fontGuard }, brandFont);
  // 后台：品牌字体生效了没有（店主 2026-11-22：放没放对一眼看得到）
  app.get('/api/admin/emenu/brand-font', { preHandler: guardAny('emenu.manage', 'studio.edit') }, async (): Promise<BrandFontStatus> => {
    const [slot] = await deps.sql<{ name: string; versionNo: number }[]>`
      SELECT a.name, v.version_no FROM (SELECT version_id FROM design_slot_assignments WHERE store_id = ${currentStoreId()} AND slot = 'emenu.font.en' ORDER BY id DESC LIMIT 1) x
      JOIN design_asset_versions v ON v.id = x.version_id JOIN design_assets a ON a.id = v.asset_id`;
    if (slot) return { state: 'active', file: null, source: 'library', libraryName: `${slot.name}（第 ${slot.versionNo} 版）`, files: [] };
    return brandFontStatus(deps.config.brandFontPath);
  });

  // ── 后台「电子菜单」 ──
  app.get('/api/admin/emenu', { preHandler: manage }, async () => readSnapshot(sql, emenuAdmin));
  app.put('/api/admin/emenu/rules', { preHandler: manage }, async (req) => saveEmenuRules(deps, req.body, ctxOf(req)));
  app.post('/api/admin/emenu/categories', { preHandler: manage }, async (req) => createEmenuCategory(deps, req.body, ctxOf(req)));
  app.put('/api/admin/emenu/categories/:id', { preHandler: manage }, async (req) => updateEmenuCategory(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.put('/api/admin/emenu/categories/:id/pages', { preHandler: manage }, async (req) => saveEmenuPages(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/admin/emenu/dishes', { preHandler: manage }, async (req) => createEmenuDish(deps, req.body, ctxOf(req)));
  app.put('/api/admin/emenu/dishes/:id', { preHandler: manage }, async (req) => updateEmenuDish(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  // 图片：压缩后的 Base64，单张不超过 1 MB
  app.post('/api/admin/emenu/images', { preHandler: manage, bodyLimit: 1_600_000 }, async (req, reply) => {
    const img = await saveEmenuImage(sql, req.body, req.actor);
    reply.code(201);
    return img;
  });
  app.post('/api/admin/emenu/draft', { preHandler: manage }, async (req) => generateEmenuDraft(deps, ctxOf(req)));
  // 英文对照表（8.0.13）：导出所有菜的中文与英文各列；填好再导入（只更新英文、空着的不动）
  app.get('/api/admin/emenu/english.csv', { preHandler: manage }, async (_req, reply) => csvReply(reply, '电子菜单英文对照表.csv', await readSnapshot(sql, emenuEnglishCsv)));
  app.post('/api/admin/emenu/english', { preHandler: manage, bodyLimit: 4_000_000 }, async (req) => importEmenuEnglish(deps, req.body, ctxOf(req)));

  // ── 点单密码 ──
  // 店主给一位员工生成 / 重置（当场显示一次）、收回
  app.post('/api/staff/:id/order-pin', { preHandler: guard('staff.manage') }, async (req) => setOrderPin(deps, parse(idParam, req.params).id, ctxOf(req)));
  app.post('/api/staff/:id/order-pin/clear', { preHandler: guard('staff.manage') }, async (req) => {
    await clearOrderPin(deps, parse(idParam, req.params).id, ctxOf(req));
    return { ok: true };
  });
  // 本人：看有没有、自己重新生成（能点单的人才用得上）
  app.get('/api/auth/order-pin', { preHandler: guard('dining.order') }, async (req) => orderPinStatus(sql, req.actor.id));
  app.post('/api/auth/order-pin', { preHandler: guard('dining.order') }, async (req) => setOrderPin(deps, req.actor.id, ctxOf(req)));
}
