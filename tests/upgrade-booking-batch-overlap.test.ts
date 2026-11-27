// 迁移 740（8.2.17 之后，不改版本号；docs/V8222_TECHNICIANS.md 第 11 节）：8.2.4 的一报多建的技师预约补「有意重叠」标记。
//   · a）8.2.4 的库（570 以前）直接升级到最新：8.2.4 一报多建的同一技师同一时段几位，升级后前台自检通过；
//   · b）已经跑过 570 的库（8.2.5–8.2.17）里留着 false 的旧一报多：跑 740 以后自检通过；740 重跑结果一样；预约别的列一个不变；
//   · 对不上的（普通预约真的重叠、没有编号的、编号对得上但整批不全的）不标、照旧报，只读核对脚本逐对列出；派对房的重叠照旧报；
//   · 现在的接口建的一报多照样能建、自检通过；SQL 推行编号与代码里的 batchRowKey 逐字一致。
// 8.2.4 的库按真的迁移文件建（570 以前的全部执行），8.2.4 一报多写的行按 v8.2.4 的 createBookingBatch 原样写
// （它与现在的代码只差 technician_overlap 这一列和 8.2.5 加的权限核对：git diff v8.2.4 e3042ee -- src/server/modules/bookings.ts）；
// 写法与现在的接口逐项核对（最后一组用例）。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { hashRequest } from '../src/server/lib/idempotency';
import { nextDocNo } from '../src/server/lib/tx';
import { migrate } from '../src/server/migrate';
import { batchRowKey, bookingChecks } from '../src/server/modules/bookings';
import { createStaff } from '../src/server/modules/staff';
import { ALL_MIGRATIONS, api, migrationsFrom, PASSWORD, login, setup, TEST_DB, type TestContext } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const M740 = '740_booking_batch_overlap.sql';
const DIAGNOSE = new URL('../scripts/diagnose-booking-overlap.sql', import.meta.url);

type Db = Sql;

/** 一报多的一行，按 v8.2.4 的 BatchRow 解析以后的样子（键的顺序与默认值都照 zod 的输出） */
interface BatchRow {
  guestName: string;
  tagCode: string;
  guestPhone: string;
  itemId: number;
  technicianId: number | null;
  startsAt: string;
  note: string;
}

/** v8.2.4 前台自检「预约不重叠」（那时还没有 technician_overlap，一报多的重叠也报） */
async function check824(db: Db) {
  const tech = await db<{ ref: string }[]>`
    SELECT a.booking_no AS ref FROM bookings a JOIN bookings b ON b.id > a.id AND b.technician_id = a.technician_id
      AND b.starts_at < a.ends_at AND a.starts_at < b.ends_at
    WHERE a.status IN ('pending', 'confirmed') AND b.status IN ('pending', 'confirmed') LIMIT 5`;
  return { ok: tech.length === 0, detail: tech.length ? `有重叠的预约：${tech.map((t) => t.ref).join('、')}` : '没有重叠' };
}

/**
 * v8.2.4 的一报多（createBookingBatch → createBookingTx）写进库里的东西：每行一张预约（client_key = batchRowKey(整批编号, i)、
 * request_hash = hashRequest({ batch, row, ...行 })、已预约、经办人确认）与一条 booking_create 审计；整批一条操作编号
 * （booking_create、request_hash = hashRequest({ op: 'booking_batch', source, rows })、ref_id = 第 1 张）。v8.2.4 没有 technician_overlap 列
 */
async function write824Batch(db: Db, o: { key: string; source: 'front' | 'phone'; staffId: number; minutes: number; rows: BatchRow[]; at?: Date; keyStaffId?: number }) {
  const at = o.at ?? new Date('2026-11-20T02:00:00Z');
  const ids: number[] = [];
  await db.begin(async (tx) => {
    for (const [i, r] of o.rows.entries()) {
      const date = '2026-11-21';
      const bookingNo = await nextDocNo(tx, 'booking', 'YY', date);
      const start = new Date(r.startsAt);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO bookings (booking_no, kind, source, status, member_id, guest_name, guest_phone, guests, item_id, technician_id, space_id, room_type_id,
                              starts_at, ends_at, hold_until, note, business_date, created_by, created_at, client_key, request_hash, confirmed_by, confirmed_at, tag_code)
        VALUES (${bookingNo}, 'technician', ${o.source}, 'confirmed', ${null}, ${r.guestName}, ${r.guestPhone}, 1, ${r.itemId}, ${r.technicianId},
                ${null}, ${null}, ${start}, ${new Date(start.getTime() + o.minutes * 60_000)}, ${null}, ${r.note}, ${date}, ${o.staffId}, ${at},
                ${batchRowKey(o.key, i)}, ${hashRequest({ batch: o.key, row: i, ...r })}, ${o.staffId}, ${at}, ${r.tagCode})
        RETURNING id`;
      ids.push(Number(row!.id));
      await tx`INSERT INTO audit_logs (staff_id, action, target_type, target_id, detail, business_date)
               VALUES (${o.staffId}, 'booking_create', 'booking', ${String(row!.id)}, ${tx.json({ bookingNo, kind: '技师', source: o.source })}, ${date})`;
    }
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id)
             VALUES (${o.key}, 'booking_create', ${hashRequest({ op: 'booking_batch', source: o.source, rows: o.rows })}, ${ids[0]!}, ${o.keyStaffId ?? o.staffId})`;
  });
  return ids;
}

/** 单张新建（v8.2.4 createBooking）：client_key 就是操作编号，编号的 ref_id 是这张；keyed=false 时不记编号（导入、演示数据那样没有出处的） */
async function writeSingle(db: Db, o: { staffId: number; itemId: number; technicianId: number; startsAt: string; minutes: number; keyed: boolean; guestName: string }) {
  const key = randomUUID();
  const hash = hashRequest({ single: o.guestName });
  const date = '2026-11-21';
  const start = new Date(o.startsAt);
  return db.begin(async (tx) => {
    const bookingNo = await nextDocNo(tx, 'booking', 'YY', date);
    const [row] = await tx<{ id: number }[]>`
    INSERT INTO bookings (booking_no, kind, source, status, guest_name, guests, item_id, technician_id, starts_at, ends_at, business_date,
                          created_by, client_key, request_hash, confirmed_by, confirmed_at)
    VALUES (${bookingNo}, 'technician', 'front', 'confirmed', ${o.guestName}, 1, ${o.itemId}, ${o.technicianId}, ${start}, ${new Date(start.getTime() + o.minutes * 60_000)},
            ${date}, ${o.staffId}, ${key}, ${hash}, ${o.staffId}, now())
    RETURNING id, booking_no`;
    if (o.keyed) await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${key}, 'booking_create', ${hash}, ${row!.id}, ${o.staffId})`;
    return { id: Number(row!.id), bookingNo };
  });
}

const row = (guestName: string, itemId: number, technicianId: number | null, startsAt: string): BatchRow => ({
  guestName,
  tagCode: '',
  guestPhone: '',
  itemId,
  technicianId,
  startsAt,
  note: '',
});

/** 预约整行快照（technician_overlap 另外看） */
async function snapshot(db: Db) {
  const rows = await db<Record<string, unknown>[]>`SELECT * FROM bookings ORDER BY id`;
  return rows.map(({ technicianOverlap: _, ...rest }) => JSON.stringify(rest));
}
const flags = async (db: Db) =>
  (await db<{ bookingNo: string; technicianOverlap: boolean }[]>`SELECT booking_no, technician_overlap FROM bookings ORDER BY id`).map((r) => `${r.bookingNo}:${r.technicianOverlap}`);
const backfillAudits = async (db: Db) => (await db<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'booking_overlap_backfill'`)[0]!.n;
const diagnose = async (db: Db) => {
  const text = await readFile(DIAGNOSE, 'utf8');
  // 只读：在只读事务里跑，写了什么就会报错
  return db.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    return tx.unsafe<{ bookingA: string; bookingB: string; aEvidence: string; bEvidence: string; aBefore570: boolean; bBefore570: boolean }[]>(text);
  });
};

let sql: Sql;

/** 按真的迁移文件建库：until 以前（不含）的全部执行并登记 */
async function schemaBefore(until: string) {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < until).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

/** 8.2.4 的库里的合成主数据：一位经办人、一个 60 分钟要技师的项目、三位技师 */
async function seed824() {
  const [staff] = await sql<{ id: number }[]>`INSERT INTO staff (username, display_name, role, password_hash) VALUES ('u_duty', '值班经理', 'duty_manager', 'x') RETURNING id`;
  const [other] = await sql<{ id: number }[]>`INSERT INTO staff (username, display_name, role, password_hash) VALUES ('u_clerk', '店员', 'clerk', 'x') RETURNING id`;
  const [item] = await sql<{ id: number }[]>`INSERT INTO service_items (name, category, price, technician_required) VALUES ('合成足疗', '足疗', 19800, true) RETURNING id`;
  const techs: number[] = [];
  for (const no of ['T1', 'T2', 'T3', 'T4']) {
    const [t] = await sql<{ id: number }[]>`INSERT INTO technicians (tech_no, name, gender, grade) VALUES (${no}, ${`技师${no}`}, 'female', 'standard') RETURNING id`;
    techs.push(Number(t!.id));
  }
  return { staffId: Number(staff!.id), otherStaffId: Number(other!.id), itemId: Number(item!.id), techs };
}

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('a）8.2.4 的库直接升级到最新', () => {
  it('8.2.4 一报多建的同一技师同一时段几位：8.2.4 的自检报重叠，升级到最新以后自检通过；只改了标记', async () => {
    await schemaBefore('570');
    const s = await seed824();
    const key = randomUUID();
    const at = '2026-11-21T02:00:00.000Z';
    await write824Batch(sql, {
      key,
      source: 'front',
      staffId: s.staffId,
      minutes: 60,
      rows: [row('王', s.itemId, s.techs[0]!, at), row('李', s.itemId, s.techs[0]!, at), { ...row('张', s.itemId, null, at), tagCode: 'K001', guestPhone: '13900000011' }],
    });
    const before824 = await check824(sql);
    expect(before824.ok).toBe(false);
    const snap = await snapshot(sql);
    const applied = await migrate(sql);
    expect(applied[0]).toBe('570_review_v825.sql');
    // 跑到最新（740 以后还有别的版本的迁移）
    expect(applied).toContain(M740);
    expect(applied.at(-1)).toBe(ALL_MIGRATIONS.at(-1));
    const after = await bookingChecks(sql);
    console.log(`[a 8.2.4 → 最新] 升级前（8.2.4 的自检）：${before824.ok ? '✓' : '✗'} ${before824.detail}\n[a 8.2.4 → 最新] 升级后：${after.ok ? '✓' : '✗'} ${after.detail}`);
    expect(after.ok, after.detail).toBe(true);
    // 三行都是一报多建的（不指定技师的那行现在的代码也写 true），每张一条审计；别的列一个不变
    expect((await flags(sql)).every((f) => f.endsWith(':true'))).toBe(true);
    expect(await backfillAudits(sql)).toBe(3);
    expect(await snapshot(sql)).toEqual(snap);
    expect(await diagnose(sql)).toEqual([]);
  }, 180_000);
});

describe('b）已经跑过 570 的库（8.2.5–8.2.17）', () => {
  let s: Awaited<ReturnType<typeof seed824>>;
  let legit: number[];
  const nos: Record<string, string> = {};

  it('570 以后旧一报多还是 false，自检误报；跑 740 以后通过；对不上的不标、照旧报，核对脚本逐对列出', async () => {
    await schemaBefore('570');
    s = await seed824();
    // 8.2.4 时建的：
    //   · 正常的一报多（T1 两位同一时段 + 一行不指定）——要标；
    //   · 普通单张新建的真重叠（T2，数据坏了）——不标、照旧报；
    //   · 没有操作编号的重叠（T3，导入那样的）——不标、照旧报；
    //   · 编号对得上但第 0 行不是编号记的那张（T4，经办人另一个人）——整批不全，不标、照旧报
    legit = await write824Batch(sql, {
      key: randomUUID(),
      source: 'phone',
      staffId: s.staffId,
      minutes: 60,
      rows: [row('王', s.itemId, s.techs[0]!, '2026-11-21T02:00:00.000Z'), row('李', s.itemId, s.techs[0]!, '2026-11-21T02:30:00.000Z'), row('张', s.itemId, null, '2026-11-21T02:00:00.000Z')],
    });
    nos.single1 = (
      await writeSingle(sql, { staffId: s.staffId, itemId: s.itemId, technicianId: s.techs[1]!, startsAt: '2026-11-21T04:00:00.000Z', minutes: 60, keyed: true, guestName: '赵' })
    ).bookingNo;
    nos.single2 = (
      await writeSingle(sql, { staffId: s.staffId, itemId: s.itemId, technicianId: s.techs[1]!, startsAt: '2026-11-21T04:30:00.000Z', minutes: 60, keyed: true, guestName: '钱' })
    ).bookingNo;
    nos.bare1 = (
      await writeSingle(sql, { staffId: s.staffId, itemId: s.itemId, technicianId: s.techs[2]!, startsAt: '2026-11-21T06:00:00.000Z', minutes: 60, keyed: false, guestName: '孙' })
    ).bookingNo;
    nos.bare2 = (
      await writeSingle(sql, { staffId: s.staffId, itemId: s.itemId, technicianId: s.techs[2]!, startsAt: '2026-11-21T06:00:00.000Z', minutes: 60, keyed: false, guestName: '周' })
    ).bookingNo;
    // 对不上的证据（不是 8.2.4 的接口能写出来的，模拟别的入口或手工改过的数据）：编号记的经办人与预约的不一致
    const brokenIds = await write824Batch(sql, {
      key: randomUUID(),
      source: 'front',
      staffId: s.otherStaffId,
      keyStaffId: s.staffId,
      minutes: 60,
      rows: [row('吴', s.itemId, s.techs[3]!, '2026-11-21T08:00:00.000Z'), row('郑', s.itemId, s.techs[3]!, '2026-11-21T08:00:00.000Z')],
    });
    const [b0] = await sql<{ bookingNo: string }[]>`SELECT booking_no FROM bookings WHERE id = ${brokenIds[0]!}`;
    nos.broken0 = b0!.bookingNo;

    // 升到 8.2.17：570–730 都跑过，740 还没有
    const later = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql') && f >= '570' && f < '740').sort();
    for (const f of later) {
      await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
      await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
    }
    expect(later.at(-1)).toBe('730_oa_expense_retire.sql');
    // 8.2.5 起的代码建的一报多（570 以后）已经是 true：手写一份同样的，确认 740 不碰它
    const newer = await write824Batch(sql, {
      key: randomUUID(),
      source: 'front',
      staffId: s.staffId,
      minutes: 60,
      rows: [row('冯', s.itemId, s.techs[0]!, '2026-11-22T02:00:00.000Z'), row('陈', s.itemId, s.techs[0]!, '2026-11-22T02:00:00.000Z')],
      at: new Date(),
    });
    await sql`UPDATE bookings SET technician_overlap = true WHERE id IN ${sql(newer)}`;

    const before = await bookingChecks(sql);
    const snap = await snapshot(sql);
    const flagsBefore = await flags(sql);
    expect(before.ok).toBe(false);
    expect(before.detail).toContain((await sql<{ bookingNo: string }[]>`SELECT booking_no FROM bookings WHERE id = ${legit[0]!}`)[0]!.bookingNo);

    expect(await migrate(sql)).toEqual(migrationsFrom(M740));
    const after = await bookingChecks(sql);
    console.log(`[b 8.2.17 → 740] 跑 740 以前：${before.ok ? '✓' : '✗'} ${before.detail}\n[b 8.2.17 → 740] 跑 740 以后：${after.ok ? '✓' : '✗'} ${after.detail}`);
    // 旧一报多不再报；真重叠、没编号的、整批对不上的照旧报
    const legitNos = (await sql<{ bookingNo: string }[]>`SELECT booking_no FROM bookings WHERE id IN ${sql(legit)}`).map((r) => r.bookingNo);
    expect(after.ok).toBe(false);
    for (const no of legitNos) expect(after.detail).not.toContain(no);
    expect(after.detail).toContain(nos.single1);
    expect(after.detail).toContain(nos.bare1);
    expect(after.detail).toContain(nos.broken0);
    // 标上的只有旧一报多的三张（570 以后那两张本来就是 true）；审计三条
    const changed = (await flags(sql)).filter((f, i) => f !== flagsBefore[i]);
    expect(changed.sort()).toEqual(legitNos.map((n) => `${n}:true`).sort());
    expect(await backfillAudits(sql)).toBe(3);
    const audits = await sql<{ targetId: string; staffId: number | null; detail: { batchKey: string; row: number; migration: string } }[]>`
      SELECT target_id, staff_id, detail FROM audit_logs WHERE action = 'booking_overlap_backfill' ORDER BY id`;
    expect(audits.map((a) => [Number(a.targetId), a.staffId, a.detail.row, a.detail.migration])).toEqual(legit.map((id, i) => [id, null, i, M740]));
    // 别的列一个不变
    expect(await snapshot(sql)).toEqual(snap);

    // 只读核对：逐对列出还在报的，写清出处
    const pairs = await diagnose(sql);
    console.log(`[b 核对脚本] ${pairs.length} 对：\n${pairs.map((p) => `  ${p.bookingA} × ${p.bookingB}：${p.aEvidence} / ${p.bEvidence}（570 以前：${p.aBefore570}/${p.bBefore570}）`).join('\n')}`);
    expect(pairs.map((p) => [p.bookingA, p.bookingB, p.aEvidence, p.bEvidence])).toEqual([
      [nos.single1, nos.single2, '单张新建（真的重叠）', '单张新建（真的重叠）'],
      [nos.bare1, nos.bare2, '找不到操作编号', '找不到操作编号'],
      [nos.broken0, expect.any(String), '一报多编号对得上但整批不全或不一致：经办人与编号的不一致', '一报多编号对得上但整批不全或不一致：经办人与编号的不一致'],
    ]);
    expect(pairs.every((p) => p.aBefore570 && p.bBefore570)).toBe(true);
  }, 180_000);

  it('740 重跑结果一样：标记、审计、预约整行都不变', async () => {
    const snap = await snapshot(sql);
    const f = await flags(sql);
    const n = await backfillAudits(sql);
    const text = await readFile(new URL(M740, MIGRATIONS), 'utf8');
    await sql.unsafe(text);
    await sql.unsafe(text);
    expect(await snapshot(sql)).toEqual(snap);
    expect(await flags(sql)).toEqual(f);
    expect(await backfillAudits(sql)).toBe(n);
  });

  it('回滚脚本只把 740 标上的改回 false', async () => {
    const before = await flags(sql);
    // 回滚脚本自带 BEGIN / COMMIT：去掉这两句，放进一个事务里跑
    const down = (await readFile(new URL('../docs/rollback/740_booking_batch_overlap.down.sql', import.meta.url), 'utf8')).replace(/^(BEGIN|COMMIT);$/gm, '');
    await sql.begin((tx) => tx.unsafe(down));
    const legitNos = (await sql<{ bookingNo: string }[]>`SELECT booking_no FROM bookings WHERE id IN ${sql(legit)}`).map((r) => r.bookingNo);
    const after = await flags(sql);
    expect(after.filter((x, i) => x !== before[i]).sort()).toEqual(legitNos.map((no) => `${no}:false`).sort());
    // 再升级回来：照样标上
    expect(await migrate(sql)).toEqual([M740]);
    expect(await flags(sql)).toEqual(before);
  });
});

describe('最新的库：现在的接口', () => {
  let ctx: TestContext;
  let duty: string;
  let foot = 0;
  const tech: Record<string, number> = {};
  let slotsAt: string[] = [];

  beforeAll(async () => {
    ctx = await setup();
    await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
    duty = await login(ctx.app, 'duty');
    const it = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '合成足疗', category: '足疗', price: 16800, durationMinutes: 60, technicianRequired: true });
    expect(it.status, JSON.stringify(it.body)).toBe(200);
    foot = it.body.items.find((i: { name: string }) => i.name === '合成足疗').id;
    for (const no of ['B1', 'B2']) {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name: `技师${no}`, gender: 'female', grade: 'standard', skills: ['足疗'] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
    }
    const me = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body;
    const tomorrow = new Date(Date.parse(`${me.today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    slotsAt = ((await api(ctx.app, duty, 'GET', `/api/bookings/slots?kind=technician&date=${tomorrow}&itemId=${foot}`)).body as { startsAt: string }[]).map((x) => x.startsAt);
    expect(slotsAt.length).toBeGreaterThan(8);
  });
  afterAll(async () => ctx?.close());

  it('SQL 推出的行编号与 batchRowKey 逐字一致', async () => {
    const cases = Array.from({ length: 50 }, () => randomUUID()).flatMap((k) => Array.from({ length: 10 }, (_, i) => [k, i] as const));
    const rows = await ctx.sql<{ k: string; i: number; v: string }[]>`
      SELECT k, i, yuzu_booking_batch_row_key(k::uuid, i)::text AS v FROM unnest(${cases.map((c) => c[0])}::text[], ${cases.map((c) => c[1])}::int[]) AS t(k, i)`;
    expect(rows.map((r) => r.v)).toEqual(cases.map(([k, i]) => batchRowKey(k, i)));
  });

  it('现在的接口建一报多照样能建、标记是 true、自检通过；库里写的与 8.2.4 的写法逐项一致；改回 false 以后 740 认得出来', async () => {
    const clientKey = randomUUID();
    const input = [
      { guestName: '王', tagCode: 'k001', guestPhone: '13900000011', itemId: foot, technicianId: tech.B1, startsAt: slotsAt[2] },
      { guestName: '李', itemId: foot, technicianId: tech.B1, startsAt: slotsAt[2] },
      { guestName: '张', itemId: foot, technicianId: null, startsAt: slotsAt[2] },
    ];
    const r = await api(ctx.app, duty, 'POST', '/api/bookings/batch', { clientKey, rows: input, source: 'front' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ids = (r.body.bookings as { id: number }[]).map((b) => b.id);
    const check = await bookingChecks(ctx.sql);
    console.log(`[现在的接口] 一报多建好以后：${check.ok ? '✓' : '✗'} ${check.detail}`);
    expect(check.ok).toBe(true);
    // 与 write824Batch 的写法逐项核对：行编号、每行与整批的请求摘要、编号记的第 1 张、经办人
    const parsed: BatchRow[] = input.map((x) => ({
      guestName: x.guestName,
      tagCode: (x.tagCode ?? '').toUpperCase(),
      guestPhone: x.guestPhone ?? '',
      itemId: x.itemId,
      technicianId: x.technicianId!,
      startsAt: x.startsAt!,
      note: '',
    }));
    const stored = await ctx.sql<{ id: number; clientKey: string; requestHash: string; technicianOverlap: boolean; createdBy: number }[]>`
      SELECT id, client_key, request_hash, technician_overlap, created_by FROM bookings WHERE id IN ${ctx.sql(ids)} ORDER BY id`;
    expect(stored.map((b) => [b.clientKey, b.requestHash, b.technicianOverlap])).toEqual(parsed.map((p, i) => [batchRowKey(clientKey, i), hashRequest({ batch: clientKey, row: i, ...p }), true]));
    const [k] = await ctx.sql<{ opType: string; requestHash: string; refId: number; staffId: number }[]>`SELECT op_type, request_hash, ref_id, staff_id FROM idempotency_keys WHERE key = ${clientKey}`;
    expect(k).toMatchObject({ opType: 'booking_create', requestHash: hashRequest({ op: 'booking_batch', source: 'front', rows: parsed }), refId: ids[0], staffId: stored[0]!.createdBy });
    // 8.2.4 写出来的就是这样、只是没有标记：改回 false 模拟，740 认得出来、标回去
    await ctx.sql`UPDATE bookings SET technician_overlap = false WHERE id IN ${ctx.sql(ids)}`;
    expect((await bookingChecks(ctx.sql)).ok).toBe(false);
    await ctx.sql.unsafe(await readFile(new URL(M740, MIGRATIONS), 'utf8'));
    expect((await bookingChecks(ctx.sql)).ok).toBe(true);
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bookings WHERE id IN ${ctx.sql(ids)} AND technician_overlap`)[0]!.n).toBe(3);
  });

  it('普通预约的技师重叠照旧报；派对房的重叠照旧报；740 都不碰', async () => {
    // 两张单张新建（不重叠才建得了），再把第二张挪到与第一张重叠（模拟坏数据）
    const one = async (startsAt: string) => {
      const r = await api(ctx.app, duty, 'POST', '/api/bookings', { clientKey: randomUUID(), kind: 'technician', guestName: '单张', itemId: foot, technicianId: tech.B2, startsAt });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as { id: number; bookingNo: string };
    };
    const a = await one(slotsAt[6]!);
    const b = await one(slotsAt[8]!);
    await ctx.sql`UPDATE bookings SET starts_at = (SELECT starts_at FROM bookings WHERE id = ${a.id}), ends_at = (SELECT ends_at FROM bookings WHERE id = ${a.id}) WHERE id = ${b.id}`;
    let check = await bookingChecks(ctx.sql);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(a.bookingNo);
    await ctx.sql.unsafe(await readFile(new URL(M740, MIGRATIONS), 'utf8'));
    check = await bookingChecks(ctx.sql);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(a.bookingNo);
    console.log(`[现在的接口] 普通预约重叠：${check.ok ? '✓' : '✗'} ${check.detail}`);
    const pairs = await diagnose(ctx.sql);
    expect(pairs.map((p) => [p.bookingA, p.bookingB, p.aEvidence, p.bEvidence])).toEqual([[a.bookingNo, b.bookingNo, '单张新建（真的重叠）', '单张新建（真的重叠）']]);
    // 收拾掉，单看派对房
    await ctx.sql`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = '用例收尾' WHERE id = ${b.id}`;
    expect((await bookingChecks(ctx.sql)).ok).toBe(true);

    const [floor] = await ctx.sql<{ id: number }[]>`INSERT INTO floors (code, name) VALUES ('L9', '合成九楼') RETURNING id`;
    const [space] = await ctx.sql<{ id: number }[]>`INSERT INTO spaces (code, floor_id, business_type, display_name) VALUES ('X901', ${floor!.id}, '派对房', '合成派对房') RETURNING id`;
    const spaceNos: string[] = [];
    for (const n of [1, 2]) {
      const no = `YYX9-${n}`;
      await ctx.sql`
        INSERT INTO bookings (booking_no, kind, source, status, guest_name, space_id, starts_at, ends_at, business_date, created_by, client_key, request_hash, confirmed_by, confirmed_at)
        VALUES (${no}, 'space', 'front', 'confirmed', '派对', ${space!.id}, ${slotsAt[2]!}, ${new Date(Date.parse(slotsAt[2]!) + 120 * 60_000)}, current_date,
                ${ctx.ownerId}, ${randomUUID()}, ${hashRequest({ n })}, ${ctx.ownerId}, now())`;
      spaceNos.push(no);
    }
    await ctx.sql.unsafe(await readFile(new URL(M740, MIGRATIONS), 'utf8'));
    check = await bookingChecks(ctx.sql);
    console.log(`[现在的接口] 派对房重叠：${check.ok ? '✓' : '✗'} ${check.detail}`);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(spaceNos[0]);
  });
});
