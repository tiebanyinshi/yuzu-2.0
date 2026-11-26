// 热表归档（8.1.47，迁移 483，docs/DB_REVIEW_V8147.md 第 5 节）：超过保留天数的位置轨迹段与事件、对外调用记录、发完的企业微信推送挪进 archived_*；
// 还被当前位置、留下的轨迹段引用的事件不挪；没发完的推送不挪；原表平时照样不能删、不能改。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archiveOnce } from '../src/server/modules/archive';
import { setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx?.close());

const DAY = 86_400_000;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const id = async (q: Promise<{ id: number | string }[]>) => Number((await q)[0]!.id);

describe('热表归档', () => {
  it('挪走过期的、留下还在用的；挪完原表与归档表合起来一条不少', async () => {
    const sql = ctx.sql;
    const floor = await id(sql`SELECT id FROM floors ORDER BY id LIMIT 1`).catch(() => 1);
    const ev = (tech: number, kind: 'at' | 'left', at: Date) =>
      id(sql`
        INSERT INTO location_events (technician_id, kind, floor_id, source, at, recorded_at, applied)
        VALUES (${tech}, ${kind}, ${kind === 'at' ? floor : null}, 'position', ${at}, ${at}, true) RETURNING id`);
    // 技师 A：一年多前的一段（进、出）已结束；现在又在某处（新的一段没结束）
    const e1 = await ev(990001, 'at', ago(400));
    const e2 = await ev(990001, 'left', ago(399));
    const t1 = await id(sql`
      INSERT INTO location_tracks (technician_id, floor_id, entered_at, first_event_id, last_at, last_event_id, left_at, end_event_id)
      VALUES (990001, ${floor}, ${ago(400)}, ${e1}, ${ago(400)}, ${e1}, ${ago(399)}, ${e2}) RETURNING id`);
    const e3 = await ev(990001, 'at', ago(1));
    const t2 = await id(sql`
      INSERT INTO location_tracks (technician_id, floor_id, entered_at, first_event_id, last_at, last_event_id)
      VALUES (990001, ${floor}, ${ago(1)}, ${e3}, ${ago(1)}, ${e3}) RETURNING id`);
    await sql`INSERT INTO current_locations (technician_id, state, floor_id, since, track_id, last_at, last_event_id) VALUES (990001, 'at', ${floor}, ${ago(1)}, ${t2}, ${ago(1)}, ${e3})`;
    // 技师 B：最后一条事件在一年多前（离开），当前位置还指着它
    const e4 = await ev(990002, 'left', ago(400));
    await sql`INSERT INTO current_locations (technician_id, state, last_at, last_event_id) VALUES (990002, 'left', ${ago(400)}, ${e4})`;

    const call = (at: Date) =>
      id(sql`INSERT INTO integration_calls (kind, provider, action, mode, request_summary, ok, result_summary, duration_ms, created_at)
             VALUES ('einvoice', 'mock', 'issue', 'mock', '{}', true, '{}', 5, ${at}) RETURNING id`);
    const c1 = await call(ago(200));
    const c2 = await call(ago(10));
    const push = (status: string, at: Date) => id(sql`INSERT INTO wecom_pushes (kind, status, content, created_at) VALUES ('test', ${status}, '测试', ${at}) RETURNING id`);
    const p1 = await push('sent', ago(400));
    const p2 = await push('sending', ago(400));
    const p3 = await push('failed', ago(30));

    const before = await sql<{ n: number }[]>`SELECT (SELECT count(*) FROM location_events) + (SELECT count(*) FROM location_tracks) AS n`;
    const run = await archiveOnce(sql, { locationDays: 180, integrationCallDays: 180, wecomPushDays: 365 }, now);
    expect(run).toEqual({ locationTracks: 1, locationEvents: 2, integrationCalls: 1, wecomPushes: 1 });

    const ids = async (t: string) => (await sql.unsafe<{ id: string }[]>(`SELECT id FROM ${t} ORDER BY id`)).map((r) => Number(r.id));
    expect(await ids('archived_location_tracks')).toEqual([t1]);
    expect(await ids('archived_location_events')).toEqual([e1, e2]);
    expect(await ids('archived_integration_calls')).toEqual([c1]);
    expect(await ids('archived_wecom_pushes')).toEqual([p1]);
    const left = await ids('location_events');
    expect(left).toContain(e3);
    expect(left).toContain(e4);
    expect(await ids('location_tracks')).toContain(t2);
    expect(await ids('integration_calls')).toContain(c2);
    expect(await ids('wecom_pushes')).toEqual(expect.arrayContaining([p2, p3]));
    const after = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM location_events) + (SELECT count(*) FROM location_tracks)
           + (SELECT count(*) FROM archived_location_events) + (SELECT count(*) FROM archived_location_tracks) AS n`;
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    // 原样挪过去（列一一对应，归档时刻有值）
    const [a] = await sql<{ technicianId: number; kind: string; archivedAt: string }[]>`SELECT technician_id, kind, archived_at FROM archived_location_events WHERE id = ${e2}`;
    expect(a).toMatchObject({ technicianId: 990001, kind: 'left' });
    expect(Number.isNaN(Date.parse(String(a!.archivedAt)))).toBe(false);

    // 再跑一遍没东西可挪；保留天数 0 = 不挪
    expect(await archiveOnce(sql, { locationDays: 180, integrationCallDays: 180, wecomPushDays: 365 }, now)).toEqual({ locationTracks: 0, locationEvents: 0, integrationCalls: 0, wecomPushes: 0 });
    expect(await archiveOnce(sql, { locationDays: 0, integrationCallDays: 0, wecomPushDays: 0 }, new Date(now.getTime() + 1000 * DAY))).toEqual({
      locationTracks: 0,
      locationEvents: 0,
      integrationCalls: 0,
      wecomPushes: 0,
    });
  });

  it('原表平时照样只追加；只有归档任务的事务里能删，改仍然不行；归档表只追加', async () => {
    const sql = ctx.sql;
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO integration_calls (kind, provider, action, mode, request_summary, ok, result_summary, duration_ms) VALUES ('einvoice', 'mock', 'x', 'mock', '{}', true, '{}', 1) RETURNING id`;
    await expect(sql`DELETE FROM integration_calls WHERE id = ${row!.id}`).rejects.toThrow(/只追加/);
    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('yuzu.archiving', 'on', true)`;
        await tx`UPDATE integration_calls SET ok = false WHERE id = ${row!.id}`;
      }),
    ).rejects.toThrow(/只追加/);
    const [arch] = await sql<{ id: number }[]>`SELECT id FROM archived_integration_calls LIMIT 1`;
    expect(arch, '上一条用例挪过一条').toBeTruthy();
    await expect(sql`DELETE FROM archived_integration_calls WHERE id = ${arch!.id}`).rejects.toThrow(/只追加/);
  });
});
