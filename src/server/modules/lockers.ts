// 柜况与智能柜锁（8.1.49，docs/LOCKERS_V8149.md）。柜况页的数据就是发卡台的手牌板（/api/frontdesk/board），这里只管柜锁控制器：
//   GET  /api/lockers/controller   接的是哪种控制器、能不能远程开柜（查看在店手牌就能看）
//   POST /api/lockers/doors        问控制器这几个柜门开着没有（没配控制器时为空）
//   POST /api/lockers/:id/open     远程开柜：要「维护手牌池」权限、写原因，记审计（开成没开成都记）；没配控制器回 503 LOCKER_NOT_CONFIGURED
// 开柜在事务外调控制器（不拿着数据库连接等 5 秒），之后单独写审计。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOCKER_OPEN_REASONS } from '@shared/lockers';
import { guard } from '../auth/guard';
import { createLockerController, type LockerController } from '../devices/locker-controller';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps } from '../lib/context';
import { AppError, notFound } from '../lib/errors';
import { currentStoreId } from '../lib/store-context';
import { parse } from '../lib/validate';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const DoorsInput = z.object({ codes: z.array(z.string().trim().min(1).max(16)).max(1000, '一次最多问 1000 个柜门') });
const OpenInput = z.object({ reason: z.string('请写开柜原因').trim().min(2, '请写开柜原因').max(100, '原因最多 100 个字') });

export function registerLockerRoutes(app: FastifyInstance, deps: Deps, controller: LockerController = createLockerController(deps.config.lockers)): void {
  const { sql } = deps;

  app.get('/api/lockers/controller', { preHandler: guard('frontdesk.read') }, async () => ({ ...controller.info, reasons: LOCKER_OPEN_REASONS }));

  app.post('/api/lockers/doors', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { codes } = parse(DoorsInput, req.body);
    if (!controller.info.canOpen || !codes.length) return [];
    try {
      return await controller.doors(codes);
    } catch (error) {
      req.log.warn({ err: error }, '柜锁控制器查柜门失败');
      throw new AppError(502, 'LOCKER_CONTROLLER_DOWN', '柜锁控制器没有回应，柜门状态暂时看不到');
    }
  });

  app.post('/api/lockers/:id/open', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(OpenInput, req.body);
    if (!controller.info.canOpen) throw new AppError(503, 'LOCKER_NOT_CONFIGURED', '还没有接柜锁控制器，不能远程开柜（见 docs/LOCKERS_V8149.md）');
    const [tag] = await sql<{ code: string }[]>`
      SELECT code FROM hand_tags WHERE id = ${id} AND store_id = ${currentStoreId()} AND deleted_at IS NULL`;
    if (!tag) throw notFound('没有这个柜子');
    const result = await controller.open(tag.code);
    const ctx = ctxOf(req);
    await writeAudit(sql, {
      staffId: ctx.actor.id,
      action: 'locker_opened',
      targetType: 'hand_tag',
      targetId: id,
      detail: { code: tag.code, reason, driver: controller.info.driver, opened: result.opened, message: result.message },
      ip: ctx.ip,
    });
    return result;
  });
}
