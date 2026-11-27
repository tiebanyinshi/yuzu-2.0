// 迁移执行器（8.1.54，数据库评估第 7 节）：标了 `-- yuzu:no-transaction` 的迁移不放在事务里、逐句执行（给大表 CREATE INDEX CONCURRENTLY 用），
// 前后的普通迁移照旧在事务里；顺序不乱、登记齐全，重跑什么都不做；普通迁移失败整批回滚。
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate, splitSimpleStatements } from '../src/server/migrate';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

let sql: Sql;
beforeAll(() => {
  sql = createSql(TEST_DB, { max: 2 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function dirWith(files: Record<string, string>): Promise<URL> {
  const d = await mkdtemp(join(tmpdir(), 'yuzu-mig-'));
  for (const [name, content] of Object.entries(files)) await writeFile(join(d, name), content);
  return pathToFileURL(`${d}/`);
}

describe('不在事务里的迁移', () => {
  it('拆句：去掉注释行，按行尾分号拆', () => {
    expect(splitSimpleStatements('-- yuzu:no-transaction\n-- 说明；\nDROP INDEX CONCURRENTLY IF EXISTS a;\nCREATE INDEX CONCURRENTLY a ON t (x);\n')).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS a',
      'CREATE INDEX CONCURRENTLY a ON t (x)',
    ]);
  });

  it('普通、不在事务里、普通，按顺序都执行；建出来的索引有效；重跑什么都不做', async () => {
    await resetPublicSchema(sql);
    const dir = await dirWith({
      '001_t.sql': 'CREATE TABLE t (id bigserial PRIMARY KEY, x int);\nINSERT INTO t (x) SELECT g FROM generate_series(1, 100) g;',
      '002_idx.sql': '-- yuzu:no-transaction\n-- 大表建索引不挡写入\nDROP INDEX CONCURRENTLY IF EXISTS t_x_idx;\nCREATE INDEX CONCURRENTLY t_x_idx ON t (x);\n',
      '003_u.sql': 'CREATE TABLE u (id bigserial PRIMARY KEY);',
    });
    expect(await migrate(sql, () => {}, { dir })).toEqual(['001_t.sql', '002_idx.sql', '003_u.sql']);
    const [idx] = await sql<{ valid: boolean }[]>`SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = 't_x_idx'::regclass`;
    expect(idx!.valid).toBe(true);
    expect(await sql`SELECT to_regclass('u') AS u`).toEqual([{ u: 'u' }]);
    expect(await migrate(sql, () => {}, { dir })).toEqual([]);
  });

  it('普通迁移失败整批回滚（不在事务里的那份之前已提交的保留）', async () => {
    await resetPublicSchema(sql);
    const dir = await dirWith({
      '001_t.sql': 'CREATE TABLE t (id bigserial PRIMARY KEY, x int);',
      '002_idx.sql': '-- yuzu:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_x_idx ON t (x);\n',
      '003_a.sql': 'CREATE TABLE a (id int);',
      '004_bad.sql': 'CREATE TABLE b (id int); SELECT 1/0;',
    });
    await expect(migrate(sql, () => {}, { dir })).rejects.toThrow(/division by zero/);
    const versions = (await sql<{ version: string }[]>`SELECT version FROM schema_migrations ORDER BY version`).map((r) => r.version);
    expect(versions).toEqual(['001_t.sql', '002_idx.sql']);
    expect(await sql`SELECT to_regclass('a') AS a`).toEqual([{ a: null }]);
  });
});
