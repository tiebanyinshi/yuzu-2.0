// 迁移 340（8.1.42 零采备用金并进备用金，docs/V8142_PETTY.md）升级：从 340 以前的库（有部门备用金，也有零采备用金的总额、申用与报销单）升上来——
//   · 报销单一张不少、金额与状态不变，钱从零采备用金来的改成「备用金」并挂在这个部门的并入打款上（没法挂的改成公司直付）；
//   · 各部门备用金的余额 = 原余额 + 并入的总额；归属部门的可用 = 原余额 + 零采原来的剩余可用；申用一笔不少，都记上了部门；
//   · 总额并进归属部门的定额；pool 两项权限换成「备用金申用」（岗位建议、后台岗位权限、个人微调），每个岗位一条配置日志；
//   · 「钱从哪来」再也写不进 pool；申用的部门登记后不能改；自检都过。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { expenseChecks } from '../src/server/modules/expenses';
import { pettyAccountChecks } from '../src/server/modules/petty-accounts';
import { pettyBalances, pettyOccupied, pettyUseCheck, useSummary } from '../src/server/modules/petty-uses';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const MINE = '340_petty_merge.sql';
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function schemaBefore340() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < MINE).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

const one = async <T>(q: Promise<T[]>) => (await q)[0]!;

describe('迁移 340：零采备用金并进备用金', () => {
  it('报销单、申用一笔不少；余额与可用对得上；权限、定额、模块开关一起改', async () => {
    await schemaBefore340();
    const ids = async (q: Promise<{ id: number }[]>) => Number((await q)[0]!.id);
    const boss = await ids(sql`INSERT INTO staff (username, display_name, role, duties, password_hash) VALUES ('boss', '店主', 'owner', '{}', 'x') RETURNING id`);
    const buyer = await ids(
      sql`INSERT INTO staff (username, display_name, role, duties, password_hash, permission_adjust) VALUES ('buyer', '采购', 'backoffice', '{purchase}', 'x', '{"add": ["pool.read", "pool.manage"], "remove": []}') RETURNING id`,
    );
    const clerk = await ids(
      sql`INSERT INTO staff (username, display_name, role, duties, password_hash, permission_adjust) VALUES ('clerk', '店员', 'backoffice', '{stock}', 'x', '{"add": [], "remove": ["pool.read"]}') RETURNING id`,
    );
    const D = await ids(sql`INSERT INTO departments (name) VALUES ('供应链部') RETURNING id`);
    const E = await ids(sql`INSERT INTO departments (name) VALUES ('工程部') RETURNING id`);
    await sql`INSERT INTO settings (key, value) VALUES ('petty_pool', ${sql.json({ totalCents: 500_000, departmentId: D })})`;
    await sql`INSERT INTO settings (key, value) VALUES ('erp_modules', ${sql.json({ pettyPool: false, expenses: true })})`;
    await sql`INSERT INTO settings (key, value) VALUES ('role_permissions', ${sql.json({ backoffice: { add: ['pool.manage'], remove: [] } })})`;
    await sql`INSERT INTO settings (key, value) VALUES ('position_permissions', ${sql.json({ 'front.staff': { add: ['pool.read'], remove: [] }, 'outreach.lead': { add: ['linen.read'], remove: ['pool.manage'] } })})`;
    await sql`INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES ('petty_pool_use', '2026-11-20', 6)`;

    // 原来的部门备用金：供应链部打款 ¥1,000、用掉 ¥200；工程部打款 ¥500
    const advance = (no: string, dept: number, cents: number) =>
      ids(sql`INSERT INTO petty_advances (doc_no, department_id, handler_id, advance_date, amount_cents, method, evidence, created_by)
              VALUES (${no}, ${dept}, ${buyer}, '2026-11-01', ${cents}, 'cash', '现金', ${boss}) RETURNING id`);
    const a1 = await advance('BY20261101-0001', D, 100_000);
    await advance('BY20261101-0002', E, 50_000);
    const claim = async (no: string, dept: number, paySource: string, adv: number | null, cents: number, status: string) => {
      const id = await claimRow(no, dept, paySource, adv, cents, status);
      await sql`INSERT INTO expense_claim_lines (claim_id, line_no, name, category, unit, bought_milli, received_milli, amount_cents)
                VALUES (${id}, 1, '拖鞋', 'low_value', '箱', 1000, 1000, ${cents})`;
      return id;
    };
    const claimRow = (no: string, dept: number, paySource: string, adv: number | null, cents: number, status: string) =>
      ids(sql`
        INSERT INTO expense_claims (doc_no, expense_date, department_id, handler_id, purpose, pay_source, advance_id, invoice_type, invoice_label, tax_rate_bp,
                                    amount_cents, needs_approval, status, created_by, confirmed_by, confirmed_at, voided_by, voided_at, void_reason)
        VALUES (${no}, '2026-11-20', ${dept}, ${buyer}, '客用消耗', ${paySource}, ${adv}, 'receipt', '收据', 0, ${cents}, false, ${status}, ${boss},
                ${status === 'confirmed' || status === 'voided' ? boss : null}, ${status === 'confirmed' || status === 'voided' ? sql`now()` : null},
                ${status === 'voided' ? boss : null}, ${status === 'voided' ? sql`now()` : null}, ${status === 'voided' ? '重开' : null})
        RETURNING id`);
    await claim('BX20261120-0001', D, 'petty', a1, 20_000, 'confirmed');

    // 零采备用金：总额 ¥5,000；六笔申用
    const use = (no: string, cents: number, claimState: string, status = 'active') =>
      ids(sql`
        INSERT INTO petty_pool_uses (doc_no, use_date, applicant_id, purpose, content, amount_cents, claim_state, backfill, submitted_by, submitted_at,
                                     status, voided_by, voided_at, void_reason, client_key, created_by)
        VALUES (${no}, '2026-11-20', ${buyer}, '补货', '网购', ${cents}, ${claimState}, ${claimState === 'submitted' ? 'pending' : null},
                ${claimState === 'submitted' ? buyer : null}, ${claimState === 'submitted' ? sql`now()` : null},
                ${status}, ${status === 'voided' ? buyer : null}, ${status === 'voided' ? sql`now()` : null}, ${status === 'voided' ? '不买了' : null},
                gen_random_uuid(), ${buyer})
        RETURNING id`);
    const u1 = await use('LC20261120-0001', 30_000, 'submitted'); // 报销单已确认（已回补）
    const u2 = await use('LC20261120-0002', 250_000, 'submitted'); // 报销单待确认（审核中）
    const u3 = await use('LC20261120-0003', 10_000, 'open'); // 待报销
    const u4 = await use('LC20261120-0004', 5_000, 'open', 'voided'); // 作废
    const u5 = await use('LC20261120-0005', 20_000, 'submitted'); // 报销单记在工程部、已确认
    const u6 = await use('LC20261120-0006', 7_000, 'submitted'); // 报销单冲销了，又占用
    const link = (c: number, u: number) => sql`INSERT INTO expense_claim_pool_uses (claim_id, use_id) VALUES (${c}, ${u})`;
    const c1 = await claim('BX20261120-0002', D, 'pool', null, 28_000, 'confirmed');
    const c2 = await claim('BX20261120-0003', D, 'pool', null, 249_900, 'submitted');
    const c3 = await claim('BX20261120-0004', E, 'pool', null, 20_000, 'confirmed');
    const c4 = await claim('BX20261120-0005', D, 'pool', null, 7_000, 'voided');
    await link(c1, u1);
    await link(c2, u2);
    await link(c3, u5);
    await link(c4, u6);

    // ── 升级前 ──
    const claimsBefore = await sql`SELECT id, doc_no, amount_cents, status FROM expense_claims ORDER BY id`;
    const balance = async (dept: number) =>
      Number(
        (
          await one(
            sql<{ cents: number }[]>`
          SELECT coalesce(sum(a.amount_cents - coalesce((SELECT sum(c.amount_cents) FROM expense_claims c WHERE c.advance_id = a.id AND c.status = 'confirmed'), 0)), 0)::bigint AS cents
          FROM petty_advances a WHERE a.status = 'active' AND a.department_id = ${dept}`,
          )
        ).cents,
      );
    const beforeD = await balance(D);
    const beforeE = await balance(E);
    expect([beforeD, beforeE]).toEqual([80_000, 50_000]);
    // 零采的占用（没作废、挂的报销单没确认的）与剩余可用
    const occupiedBefore = Number(
      (
        await one(
          sql<{ cents: number }[]>`
        SELECT coalesce(sum(u.amount_cents), 0)::bigint AS cents FROM petty_pool_uses u
        WHERE u.status = 'active' AND NOT EXISTS (SELECT 1 FROM expense_claim_pool_uses l JOIN expense_claims c ON c.id = l.claim_id WHERE l.use_id = u.id AND c.status = 'confirmed')`,
        )
      ).cents,
    );
    expect(occupiedBefore).toBe(250_000 + 10_000 + 7_000);
    const remainingBefore = 500_000 - occupiedBefore;

    // ── 升级 ──
    expect(await migrate(sql)).toContain(MINE);

    // 报销单：张数、金额、状态一样；零采的改成备用金、挂在本部门的并入打款上
    expect(await sql`SELECT id, doc_no, amount_cents, status FROM expense_claims ORDER BY id`).toEqual(claimsBefore);
    expect((await sql`SELECT count(*)::int AS n FROM expense_claims WHERE pay_source NOT IN ('petty', 'company')`)[0]!.n).toBe(0);
    const merge = await sql<{ departmentId: number; advanceId: number; poolTotalCents: number; confirmedCents: number; pettyClaimIds: number[] }[]>`
      SELECT department_id, advance_id, pool_total_cents, confirmed_cents, petty_claim_ids FROM petty_merge_log ORDER BY department_id`;
    expect(merge.map((m) => [Number(m.departmentId), Number(m.poolTotalCents), Number(m.confirmedCents), m.pettyClaimIds.map(Number)])).toEqual([
      [D, 500_000, 28_000, [c1, c2, c4]],
      [E, 0, 20_000, [c3]],
    ]);
    const advD = await one(sql<{ amountCents: number; departmentId: number; docNo: string }[]>`SELECT amount_cents, department_id, doc_no FROM petty_advances WHERE id = ${merge[0]!.advanceId}`);
    expect(advD).toMatchObject({ amountCents: 528_000, departmentId: D });
    expect(advD.docNo).toMatch(/^BY\d{8}-\d{4}$/);
    for (const [c, m] of [
      [c1, merge[0]!],
      [c2, merge[0]!],
      [c4, merge[0]!],
      [c3, merge[1]!],
    ] as const) {
      const row = await one(sql<{ paySource: string; advanceId: number; departmentId: number }[]>`SELECT pay_source, advance_id, department_id FROM expense_claims WHERE id = ${c}`);
      expect({ paySource: row.paySource, advanceId: Number(row.advanceId) }).toEqual({ paySource: 'petty', advanceId: Number(m.advanceId) });
    }

    // 余额：原余额 + 并入的总额；工程部不变（已确认的零采报销与并入打款正好抵掉）
    const balances = await pettyBalances(sql);
    expect(balances.get(D)).toBe(beforeD + 500_000);
    expect(balances.get(E)).toBe(beforeE);
    // 可用：归属部门 = 原余额 + 零采原来的剩余可用；占用合计不变
    const occupied = await pettyOccupied(sql);
    expect((occupied.get(D) ?? 0) + (occupied.get(E) ?? 0)).toBe(occupiedBefore);
    const sD = await useSummary(sql, 'Asia/Shanghai', D);
    expect(sD).toMatchObject({ limitCents: 500_000, balanceCents: beforeD + 500_000, occupiedCents: occupiedBefore, availableCents: beforeD + remainingBefore });

    // 申用：一笔不少、单号不变，都记上了部门（挂着有效报销单的跟报销单的部门）
    const uses = await sql<{ id: number; docNo: string; departmentId: number }[]>`SELECT id, doc_no, department_id FROM petty_uses ORDER BY id`;
    expect(uses.map((u) => [Number(u.id), u.docNo, Number(u.departmentId)])).toEqual([
      [u1, 'LC20261120-0001', D],
      [u2, 'LC20261120-0002', D],
      [u3, 'LC20261120-0003', D],
      [u4, 'LC20261120-0004', D],
      [u5, 'LC20261120-0005', E],
      [u6, 'LC20261120-0006', D],
    ]);
    expect((await sql`SELECT count(*)::int AS n FROM expense_claim_petty_uses`)[0]!.n).toBe(4);
    expect(await sql`SELECT last_no FROM doc_counters WHERE doc_type = 'petty_use'`).toEqual([{ lastNo: 6 }]);

    // 定额、模块开关、权限
    expect(await sql`SELECT limit_cents FROM petty_accounts WHERE department_id = ${D}`).toEqual([{ limitCents: 500_000 }]);
    expect((await one(sql<{ value: Record<string, unknown> }[]>`SELECT value FROM settings WHERE key = 'erp_modules'`)).value).toEqual({ expenses: true });
    expect((await one(sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'role_permissions'`)).value).toEqual({ backoffice: { add: ['petty.use'], remove: [] } });
    expect((await one(sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'position_permissions'`)).value).toEqual({
      'front.staff': { add: ['petty.use'], remove: [] },
      'outreach.lead': { add: ['linen.read'], remove: ['petty.use'] },
    });
    const adjust = async (id: number) => (await one(sql<{ permissionAdjust: unknown }[]>`SELECT permission_adjust FROM staff WHERE id = ${id}`)).permissionAdjust;
    expect(await adjust(buyer)).toEqual({ add: ['petty.use'], remove: [] });
    expect(await adjust(clerk)).toEqual({ add: [], remove: ['petty.use'] });
    expect((await sql`SELECT count(*)::int AS n FROM position_suggestions WHERE permission LIKE 'pool.%'`)[0]!.n).toBe(0);
    const withUse = (await sql<{ positionKey: string }[]>`SELECT position_key FROM position_suggestions WHERE permission = 'petty.use' ORDER BY 1`).map((r) => r.positionKey);
    expect(withUse).toEqual(expect.arrayContaining(['outreach.lead', 'outreach.staff']));
    const logs = await sql<{ positionKey: string; detail: { added: string[]; removed: string[] } }[]>`
      SELECT position_key, detail FROM position_config_log WHERE detail ->> 'note' LIKE '%迁移 340%' ORDER BY position_key`;
    expect(logs.map((l) => l.positionKey)).toEqual(withUse);
    expect(logs[0]!.detail.added).toEqual(['petty.use']);

    // 自检都过
    expect(await pettyUseCheck(sql)).toMatchObject({ ok: true });
    expect((await pettyAccountChecks(sql)).every((c) => c.ok)).toBe(true);
    const bad = (await expenseChecks(sql)).filter((c) => !c.ok);
    expect(bad, JSON.stringify(bad)).toEqual([]);

    // 「钱从哪来」再也写不进 pool；申用的部门登记后不能改
    await expect(sql`UPDATE expense_claims SET pay_source = 'pool', advance_id = NULL WHERE id = ${c2}`).rejects.toThrow();
    await expect(
      sql`INSERT INTO expense_claims (doc_no, expense_date, department_id, handler_id, purpose, pay_source, invoice_type, invoice_label, tax_rate_bp, amount_cents, needs_approval, status, created_by)
          VALUES ('BX-X', '2026-11-20', ${D}, ${buyer}, '办公', 'pool', 'receipt', '收据', 0, 100, false, 'submitted', ${boss})`,
    ).rejects.toThrow(/check/);
    await expect(sql`UPDATE petty_uses SET department_id = ${E} WHERE id = ${u3}`).rejects.toThrow(/不能修改/);
    // 再跑一次迁移什么都不做
    expect(await migrate(sql)).toEqual([]);

    // 回滚脚本：回到 340 以前（报销单回到零采备用金、并入打款去掉、定额与权限改回）；再升级一次结果一样
    // 回滚脚本自己带 BEGIN / COMMIT（给 psql 用）；这里去掉，放进一个事务里执行
    const down = (await readFile(new URL('../docs/rollback/340_petty_merge.down.sql', import.meta.url), 'utf8')).replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '');
    await sql.begin((tx) => tx.unsafe(down));
    expect((await sql`SELECT count(*)::int AS n FROM expense_claims WHERE pay_source = 'pool' AND advance_id IS NULL`)[0]!.n).toBe(4);
    expect((await sql`SELECT count(*)::int AS n FROM petty_advances`)[0]!.n).toBe(2);
    expect(await sql`SELECT to_regclass('petty_pool_uses')::text AS t`).toEqual([{ t: 'petty_pool_uses' }]);
    expect((await sql`SELECT count(*)::int AS n FROM petty_accounts`)[0]!.n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM position_suggestions WHERE permission = 'pool.manage'`)[0]!.n).toBeGreaterThan(0);
    expect(await sql`SELECT doc_type FROM doc_counters WHERE doc_type LIKE 'petty%use'`).toEqual([{ docType: 'petty_pool_use' }]);
    expect(await migrate(sql)).toEqual([MINE]);
    expect((await pettyBalances(sql)).get(D)).toBe(beforeD + 500_000);
    expect((await useSummary(sql, 'Asia/Shanghai', D)).availableCents).toBe(beforeD + remainingBefore);
  });

  it('什么都没用过的库：只改结构，不登记打款、不改定额', async () => {
    await schemaBefore340();
    await sql`INSERT INTO staff (username, display_name, role, duties, password_hash) VALUES ('boss', '店主', 'owner', '{}', 'x')`;
    expect(await migrate(sql)).toContain(MINE);
    expect((await sql`SELECT count(*)::int AS n FROM petty_advances`)[0]!.n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM petty_merge_log`)[0]!.n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM petty_accounts`)[0]!.n).toBe(0);
    expect(await sql`SELECT to_regclass('petty_pool_uses') AS old, to_regclass('petty_uses')::text AS now`).toEqual([{ old: null, now: 'petty_uses' }]);
  });
});
