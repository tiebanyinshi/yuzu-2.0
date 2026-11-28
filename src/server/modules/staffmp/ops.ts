// 员工小程序上的「确认作废」（docs/STAFF_MP.md 第 2.8、8.1 节；AGENTS.md「结果待确认」）：
//   POST /api/staffmp/ops/:key/abandon   { type: 'oa_punch' | 'oa_approval_submit' | 'oa_approval_act' }
// 打卡、发起申请、处理审批没收到结果，按原编号原样重提又被门店明确拒绝时，不能断定前一次没生效（打卡在锁编号之前先核对考勤组与位置，
// 前一次可能还在路上或在比对人脸）。小程序先在这里作废原编号：前一次已经办了的回 found（再原样重提就拿到原来那一次）；
// 没办的登记作废，前一次之后即使到达也整笔回滚（各接口在事务里查 op_fences），这才算没办。
// 与网页的 /api/erp/ops/:key/abandon 同一套（lib/fences.ts 的 fenceKey、erp-ops.ts 的 lookupErpOp），只认这三类、只能作废自己的；
// 加锁：只锁这一个操作编号（与原接口的 lockOpKey 是同一把，docs/LOCKING.md 第 11 节）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ErpOpLookup } from '@shared/erp';
import { STAFFMP_FENCE_TYPES } from '@shared/staffmp';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { conflict, forbidden } from '../../lib/errors';
import { fenceKey } from '../../lib/fences';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { lookupErpOp } from '../erp-ops';

const KeyParam = z.object({ key: z.uuid('操作编号格式不正确') });
const AbandonInput = z.object({ type: z.enum(STAFFMP_FENCE_TYPES, '员工小程序上只能作废打卡、发起申请与处理审批') });

export function registerStaffMpOpsRoutes(app: FastifyInstance, { sql }: Deps) {
  app.post('/api/staffmp/ops/:key/abandon', { preHandler: guard() }, async (req): Promise<ErpOpLookup> => {
    const { key } = parse(KeyParam, req.params);
    const { type } = parse(AbandonInput, req.body ?? {});
    const me = req.actor.id;
    const outcome = await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const result = await fenceKey(tx, key, type, me);
      // 编号是别人的（办过的记在 idempotency_keys，作废过的记在 op_fences）：整笔回滚，刚登记的作废也不留
      const owners = await tx<{ staffId: number }[]>`
        SELECT staff_id FROM idempotency_keys WHERE key = ${key}::uuid
        UNION SELECT staff_id FROM op_fences WHERE key = ${key}::uuid AND op_type = ${type}`;
      if (owners.some((row) => Number(row.staffId) !== me)) throw forbidden('只能作废自己的打卡、申请与审批');
      if ('inserted' in result && result.inserted) {
        await writeAudit(tx, {
          staffId: me,
          action: 'erp_op_abandoned',
          targetType: 'operation',
          targetId: key,
          detail: { idempotencyKey: key, type, summary: '员工小程序：原样重提被拒，作废原编号' },
          ip: req.ip,
        });
      }
      return result;
    });
    if ('existingOpType' in outcome && outcome.existingOpType !== type) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号属于其他业务，不能在这里作废');
    return lookupErpOp(sql, key, type);
  });
}
