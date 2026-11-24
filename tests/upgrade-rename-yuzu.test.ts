// 迁移 262（改名「浴族」→「柚子」）从 8.1.29 升上来（测试会话报告，店主 2026-11-24 同意破例改已发布的 262）：
//   · 没撞名：默认门店名设置、本店、本公司都改成「柚子 · 城市汤泉」；
//   · 另一间分店、另一个公司主体（或两处同时）已经叫「柚子 · 城市汤泉」：升级照样完成，撞名的那一行留旧名，ID、关联、已有那家的名字都不动；
//   · 店里自己改过名字的不动；再跑一次迁移什么都不做；回滚脚本撞名时不动店里自己那家。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const MINE = '262_rename_yuzu.sql';
const OLD = '浴族 · 城市汤泉';
const NEW = '柚子 · 城市汤泉';
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function schemaBefore262() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < MINE).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

async function snapshot() {
  const [setting] = await sql<{ value: string }[]>`SELECT value FROM settings WHERE key = 'store_name'`;
  const stores = await sql<{ id: number; name: string; entityId: number }[]>`SELECT id, name, entity_id FROM stores ORDER BY id`;
  const entities = await sql<{ id: number; name: string }[]>`SELECT id, name FROM legal_entities ORDER BY id`;
  return { setting: setting?.value, stores: stores.map((s) => ({ ...s, id: Number(s.id), entityId: Number(s.entityId) })), entities: entities.map((e) => ({ ...e, id: Number(e.id) })) };
}

async function prepare(opts: { storeTaken: boolean; entityTaken: boolean }) {
  await schemaBefore262();
  // 8.1.29 的库：默认名还是旧的（001 写的设置、153 照它建的本店与本公司）
  const before = await snapshot();
  expect(before.setting).toBe(OLD);
  expect(before.stores.some((s) => s.name === OLD)).toBe(true);
  expect(before.entities.some((e) => e.name === OLD)).toBe(true);
  const home = before.stores.find((s) => s.name === OLD)!;
  if (opts.entityTaken) await sql`INSERT INTO legal_entities (name) VALUES (${NEW})`;
  if (opts.storeTaken) await sql`INSERT INTO stores (code, name, entity_id) VALUES ('B2', ${NEW}, ${home.entityId})`;
  return { home, before: await snapshot() };
}

describe('迁移 262：改名遇到新名字已被占用', () => {
  it('没撞名：三处都改成新名字；再跑一次什么都不做', async () => {
    const { home } = await prepare({ storeTaken: false, entityTaken: false });
    expect(await migrate(sql)).toContain(MINE);
    const after = await snapshot();
    expect(after.setting).toBe(NEW);
    expect(after.stores.find((s) => s.id === home.id)).toMatchObject({ name: NEW, entityId: home.entityId });
    expect(after.entities.find((e) => e.id === home.entityId)).toMatchObject({ name: NEW });
    expect(await migrate(sql)).toEqual([]);
    expect(await snapshot()).toEqual(after);
  });

  for (const c of [
    { label: '另一间分店已经叫新名字', storeTaken: true, entityTaken: false },
    { label: '另一个公司主体已经叫新名字', storeTaken: false, entityTaken: true },
    { label: '两处同时撞名', storeTaken: true, entityTaken: true },
  ]) {
    it(`${c.label}：升级照样完成，撞名的那一行留旧名，ID 与关联不动；回滚不动店里自己那家`, async () => {
      const { home, before } = await prepare(c);
      expect(await migrate(sql)).toContain(MINE);
      const after = await snapshot();
      // 设置没有唯一约束，照常改
      expect(after.setting).toBe(NEW);
      const homeStore = after.stores.find((s) => s.id === home.id)!;
      expect(homeStore).toMatchObject({ name: c.storeTaken ? OLD : NEW, entityId: home.entityId });
      expect(after.entities.find((e) => e.id === home.entityId)!.name).toBe(c.entityTaken ? OLD : NEW);
      // 店里自己那家原样：名字、ID 都不变；行数不变
      expect(after.stores.map((s) => s.id)).toEqual(before.stores.map((s) => s.id));
      expect(after.entities.map((e) => e.id)).toEqual(before.entities.map((e) => e.id));
      for (const s of before.stores.filter((x) => x.name === NEW)) expect(after.stores.find((y) => y.id === s.id)!.name).toBe(NEW);
      for (const e of before.entities.filter((x) => x.name === NEW)) expect(after.entities.find((y) => y.id === e.id)!.name).toBe(NEW);
      // 再跑一次什么都不做
      expect(await migrate(sql)).toEqual([]);
      expect(await snapshot()).toEqual(after);
      // 回滚：撞名没改的不动，店里自己那家也不动
      const down = (await readFile(new URL('../docs/rollback/262_rename_yuzu.down.sql', import.meta.url), 'utf8')).replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '');
      await sql.begin((tx) => tx.unsafe(down));
      const back = await snapshot();
      expect(back.setting).toBe(OLD);
      for (const s of before.stores) expect(back.stores.find((y) => y.id === s.id)!.name).toBe(s.name);
      for (const e of before.entities) expect(back.entities.find((y) => y.id === e.id)!.name).toBe(e.name);
    });
  }

  it('店里自己改过名字的不动', async () => {
    await schemaBefore262();
    await sql`UPDATE settings SET value = '"城南店"'::jsonb WHERE key = 'store_name'`;
    await sql`UPDATE stores SET name = '城南店' WHERE name = ${OLD}`;
    await sql`UPDATE legal_entities SET name = '城南公司' WHERE name = ${OLD}`;
    expect(await migrate(sql)).toContain(MINE);
    const after = await snapshot();
    expect(after.setting).toBe('城南店');
    expect(after.stores.some((s) => s.name === '城南店')).toBe(true);
    expect(after.entities.some((e) => e.name === '城南公司')).toBe(true);
    expect([...after.stores, ...after.entities].some((x) => x.name === NEW)).toBe(false);
  });
});
