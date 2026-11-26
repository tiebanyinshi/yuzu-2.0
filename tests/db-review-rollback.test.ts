// 数据库评估的迁移 480–483 可回滚（docs/DB_REVIEW_V8147.md 第 7 节，照 GitLab / Rails 的「迁移 → 回滚 → 再迁移」检查）：
// 全部迁移跑完 → 挪一条进归档 → 按 483、482、481、480 的顺序执行 docs/rollback 里的回滚 → 归档的记录回到原表、注释清空、补的索引与外键没了
// → 再迁移一遍，表、列、索引、约束、触发器、注释与第一次完全一样。
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { archiveOnce } from '../src/server/modules/archive';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const ROLLBACK = new URL('../docs/rollback/', import.meta.url);
const MINE = ['480_fk_indexes', '481_schema_comments', '482_store_fks', '483_archive_tables'];
let sql: Sql;

beforeAll(() => {
  // 回滚脚本自带 BEGIN … COMMIT：postgres.js 只在单连接时放行
  sql = createSql(TEST_DB, { max: 1 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 库结构的签名：每一项一行，排好序 */
async function signature(): Promise<string[]> {
  const rows = await sql.unsafe<{ x: string }[]>(`
    SELECT 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull
           || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' ' || coalesce(col_description(c.oid, a.attnum), '') AS x
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    UNION ALL
    SELECT 'table ' || c.relname || ' ' || coalesce(obj_description(c.oid, 'pg_class'), '') FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    UNION ALL
    SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL
    SELECT 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) || ' ' || convalidated
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'trigger ' || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
    UNION ALL
    SELECT 'func ' || p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`);
  return rows.map((r) => r.x).sort();
}

describe('迁移 480–483 可回滚', () => {
  it('迁移 → 回滚 → 再迁移，结构与第一次一样；归档的记录回到原表', async () => {
    await resetPublicSchema(sql);
    await migrate(sql);
    const first = await signature();

    await sql`INSERT INTO integration_calls (kind, provider, action, mode, request_summary, ok, result_summary, duration_ms, created_at)
              VALUES ('einvoice', 'mock', 'issue', 'mock', '{"a":1}', true, '{}', 5, now() - interval '400 days')`;
    const run = await archiveOnce(sql, { locationDays: 180, integrationCallDays: 180, wecomPushDays: 365 });
    expect(run.integrationCalls).toBe(1);

    for (const m of [...MINE].reverse()) await sql.unsafe(await readFile(new URL(`${m}.down.sql`, ROLLBACK), 'utf8'));

    const [back] = await sql<{ n: number; arch: string | null; comments: number; fkIdx: number; storeFk: number }[]>`
      SELECT (SELECT count(*)::int FROM integration_calls WHERE request_summary = '{"a":1}') AS n,
             to_regclass('archived_integration_calls')::text AS arch,
             (SELECT count(*)::int FROM pg_description d JOIN pg_class c ON c.oid = d.objoid WHERE c.relnamespace = 'public'::regnamespace) AS comments,
             (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%fk_idx') AS fk_idx,
             (SELECT count(*)::int FROM pg_constraint WHERE conname = 'room_orders_store_id_fkey') AS store_fk`;
    expect(back).toEqual({ n: 1, arch: null, comments: 0, fkIdx: 0, storeFk: 0 });
    const done = await sql<{ version: string }[]>`SELECT version FROM schema_migrations WHERE version >= '480'`;
    expect(done).toEqual([]);
    // 回到 480 以前，只追加的保护照旧
    await expect(sql`DELETE FROM integration_calls`).rejects.toThrow(/只追加/);

    expect(await migrate(sql)).toEqual(MINE.map((m) => `${m}.sql`));
    expect(await signature()).toEqual(first);
  });
});
