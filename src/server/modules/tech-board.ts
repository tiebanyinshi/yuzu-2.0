// 8.2.0 P09（回测 4-2，docs/YUZU_REQ_V820.md 第 10 节）：技师上钟轮播的数据（只读）。
// 与钟房、排位播报同一份排位（clockroomBoard），只多查一下房间在哪个区域；不带客人的姓名与手牌，大屏上只看技师与钟。
// 不加锁、不写任何东西。

import type { FastifyInstance } from 'fastify';
import { techFilterOf } from '@shared/clockroom';
import { NO_AREA, type TechBoardSession, type TechBoardStatus, type TechBoardTech, type TechBoardView } from '@shared/tech-board';
import type { Db } from '../db';
import { guardAny } from '../auth/guard';
import type { Deps } from '../lib/context';
import { clockroomBoard } from './clockroom';

const byText = (a: string, b: string) => a.localeCompare(b, 'zh-CN');

export async function techBoard(db: Db, deps: Deps): Promise<TechBoardView> {
  const board = await clockroomBoard(db, deps);
  const spaceIds = [...new Set(board.sessions.flatMap((s) => (s.space ? [s.space.id] : [])))];
  const areaRows = spaceIds.length
    ? await db<{ id: number; area: string }[]>`
        SELECT s.id, coalesce(z.name, f.name) AS area FROM spaces s JOIN floors f ON f.id = s.floor_id LEFT JOIN zones z ON z.id = s.zone_id
        WHERE s.id IN ${db(spaceIds)}`
    : [];
  const areaOf = new Map(areaRows.map((r) => [Number(r.id), r.area]));
  const techs: TechBoardTech[] = board.technicians
    .flatMap((t) => {
      const status = techFilterOf(t);
      if (status === 'leave' || status === 'off') return [];
      return [{ id: t.id, techNo: t.techNo, name: t.nickname || t.name, kind: t.kind, status: status as TechBoardStatus, position: t.position }];
    })
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.techNo.localeCompare(b.techNo, 'zh-CN', { numeric: true }));
  const sessions: TechBoardSession[] = board.sessions.map((s) => ({
    id: s.id,
    technicianId: s.technicianId,
    itemName: s.itemName,
    status: s.status,
    room: s.space?.code ?? null,
    area: s.space ? (areaOf.get(s.space.id) ?? null) : null,
    startedAt: s.startedAt,
    plannedEnd: s.plannedEnd,
    minutes: s.minutes,
    clocks: s.clocks,
  }));
  const next = techs.find((t) => t.status === 'idle' && t.position !== null) ?? null;
  return {
    serverTime: board.serverTime,
    businessDate: board.businessDate,
    techs,
    sessions,
    next: next ? { techNo: next.techNo, name: next.name } : null,
    kinds: [...new Set(techs.map((t) => t.kind).filter(Boolean))].sort(byText),
    items: [...new Set(sessions.map((s) => s.itemName))].sort(byText),
    areas: [...new Set(sessions.map((s) => s.area ?? NO_AREA))].sort(byText),
  };
}

export function registerTechBoardRoutes(app: FastifyInstance, deps: Deps) {
  // 只读：有「技师上钟轮播」的（值班经理、排位员）；钟房、排位播报看得到排位的也能看
  app.get('/api/tech-board', { preHandler: guardAny('technician.board', 'technician.dispatch', 'technician.announce') }, async () => techBoard(deps.sql, deps));
}
