// 钟房的接口（8.1.37 从 clockroom.ts 拆出来：那个文件超过 1500 行）。业务都在 clockroom.ts，这里只登记路由。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { guard, guardAny } from '../auth/guard';
import type { Deps } from '../lib/context';
import { ctxOf } from '../lib/context';
import { idParam, parse } from '../lib/validate';
import { businessDate, hashRequest, runIdempotent } from './frontdesk/common';
import { setAnnouncer } from './clock-calls';
import {
  assignLine,
  callTechnician,
  changeState,
  clockEvents,
  clockroomBoard,
  clockSpaces,
  DispatchInput,
  ExtendInput,
  extensionLine,
  finishSession,
  setSessionSpace,
  signInAll,
  startSession,
  transferSession,
  voidSession,
} from './clockroom';

export function registerClockroomRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 派钟、加钟要挂账：与前台挂账同一个入口（价格、技师、幂等的核对都在那里）
  const post = async () => (await import('./frontdesk/bills')).postCharges;

  // 看板：钟房与排位播报（回测整改 P03）共用同一份排位数据，只有排位播报的岗位也能看
  app.get('/api/clockroom', { preHandler: guardAny('technician.dispatch', 'technician.announce') }, async () => clockroomBoard(sql, deps));

  app.get('/api/clockroom/events', { preHandler: guard('technician.dispatch') }, async (req) => {
    const { date } = parse(z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() }), req.query ?? {});
    return clockEvents(sql, date ?? (await businessDate(sql, deps, new Date())));
  });

  app.post('/api/clockroom/dispatch', { preHandler: guard('technician.dispatch', 'frontdesk.operate') }, async (req) => {
    const d = parse(DispatchInput, req.body);
    const postCharges = await post();
    await postCharges(
      deps,
      d.visitId,
      { clientKey: d.clientKey, lines: [{ itemId: d.itemId, quantity: d.quantity, tier: d.tier, technicianId: d.technicianId, callType: d.callType }], expectedTotal: d.expectedTotal },
      ctxOf(req),
      { session: { dispatch: { startNow: d.startNow, skipReason: d.skipReason, spaceId: d.spaceId, bookingId: d.bookingId } } },
    );
    return clockroomBoard(sql, deps);
  });

  app.get('/api/clockroom/spaces', { preHandler: guard('technician.dispatch') }, async () => clockSpaces(sql));
  app.post('/api/clockroom/sessions/:id/space', { preHandler: guard('technician.dispatch') }, async (req) => setSessionSpace(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));

  app.post('/api/clockroom/sessions/:id/start', { preHandler: guard('technician.dispatch') }, async (req) => startSession(deps, parse(idParam, req.params).id, ctxOf(req)));
  app.post('/api/clockroom/sessions/:id/finish', { preHandler: guard('technician.dispatch') }, async (req) => finishSession(deps, parse(idParam, req.params).id, ctxOf(req)));
  app.post('/api/clockroom/sessions/:id/void', { preHandler: guard('technician.dispatch', 'frontdesk.operate') }, async (req) =>
    voidSession(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );

  app.post('/api/clockroom/sessions/:id/extend', { preHandler: guard('technician.dispatch', 'frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const e = parse(ExtendInput, req.body);
    const { PostInput, postChargesTx } = await import('./frontdesk/bills');
    // 操作编号的摘要按提交上来的（钟单、钟数、合计）算，不按查出来的明细算：价格档在两次提交之间变了（PC28，标准档换成专业档）
    // 原样重提照样认得出是同一笔（与房态中心续钟同一个做法）
    const requestHash = hashRequest({ op: 'session_extend', sessionId: id, quantity: e.quantity, expectedTotal: e.expectedTotal });
    // 升级前发出、没收到结果的原请求，编号记的是按当时明细算的摘要：对得上就原样当重提
    const [had] = await sql<{ opType: string; requestHash: string }[]>`SELECT op_type, request_hash FROM idempotency_keys WHERE key = ${e.clientKey}`;
    if (had && had.opType === 'bill_post' && had.requestHash !== requestHash) {
      for (const remapTier of [false, true]) {
        const x = await extensionLine(sql, id, e.quantity, { remapTier }).catch(() => null);
        if (!x) continue;
        const { clientKey: _k, ...payload } = parse(PostInput, { clientKey: e.clientKey, lines: [x.line], expectedTotal: e.expectedTotal });
        if (hashRequest({ visitId: x.visitId, ...payload }) === had.requestHash) return clockroomBoard(sql, deps);
      }
    }
    await runIdempotent(deps, { key: e.clientKey, opType: 'bill_post', requestHash }, async (tx) => {
      const x = await extensionLine(tx, id, e.quantity);
      const posted = await postChargesTx(
        tx,
        deps,
        x.visitId,
        parse(PostInput, { clientKey: e.clientKey, lines: [x.line], expectedTotal: e.expectedTotal }),
        { key: e.clientKey, requestHash, backfill: null },
        ctxOf(req),
        {
          session: { extendId: id },
        },
      );
      return posted.visitId;
    });
    return clockroomBoard(sql, deps);
  });

  // 8.0.8：待派钟补派（A01）、转钟（B05）
  app.post('/api/clockroom/lines/:id/assign', { preHandler: guard('technician.dispatch', 'frontdesk.operate') }, async (req) => assignLine(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/clockroom/sessions/:id/transfer', { preHandler: guard('technician.dispatch', 'frontdesk.operate') }, async (req) =>
    transferSession(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );

  app.post('/api/clockroom/technicians/:id/state', { preHandler: guard('technician.dispatch') }, async (req) => changeState(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/clockroom/sign-in-all', { preHandler: guard('technician.dispatch') }, async (req) => signInAll(deps, ctxOf(req)));

  // 8.1.15 排位播报：手动叫号、登记主播报终端（接管、放下、报到）；回测整改 P03 起是单独的页面与权限，钟房的岗位照旧能叫号
  const announce = guardAny('technician.dispatch', 'technician.announce');
  app.post('/api/clockroom/calls', { preHandler: announce }, async (req) => callTechnician(deps, req.body, ctxOf(req)));
  app.post('/api/clockroom/announcer', { preHandler: announce }, async (req) => {
    await setAnnouncer(deps, req.body, ctxOf(req));
    return clockroomBoard(sql, deps);
  });
}
