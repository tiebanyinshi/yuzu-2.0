// 回滚脚本（docs/rollback/*.down.sql）删只追加表的记录时，要先临时关掉那张表禁止删除的触发器、删完再打开：
// 不然在真有记录的库上回滚会整笔失败（Codex 审查 PR #191：op_fences 的作废登记；223、234–237 的回滚脚本同样的问题）。
// 只追加表 = 迁移里给它建了 BEFORE … DELETE 触发器、执行 yuzu_forbid_* 的表。不要数据库，秒级。

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const ROLLBACK = new URL('../docs/rollback/', import.meta.url);

/** 表 → 禁止删除的触发器名 */
function guardedTables(): Map<string, Set<string>> {
  const guarded = new Map<string, Set<string>>();
  const re = /CREATE TRIGGER\s+(\w+)\s+BEFORE\s+[\w\s]*\bDELETE\b[\w\s]*\bON\s+(\w+)\s+FOR EACH ROW EXECUTE FUNCTION\s+yuzu_forbid_\w+/gi;
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql'))) {
    for (const m of readFileSync(new URL(f, MIGRATIONS), 'utf8').matchAll(re)) {
      const set = guarded.get(m[2]!) ?? new Set<string>();
      set.add(m[1]!);
      guarded.set(m[2]!, set);
    }
  }
  return guarded;
}

describe('回滚脚本删只追加表', () => {
  it('删之前关掉那张表禁止删除的触发器、删完再打开（先 DROP 了这张表的不算）', () => {
    const guarded = guardedTables();
    expect(guarded.get('op_fences')?.has('op_fences_append_only')).toBe(true);
    const problems: string[] = [];
    for (const f of readdirSync(ROLLBACK).filter((x) => x.endsWith('.sql'))) {
      const sql = readFileSync(new URL(f, ROLLBACK), 'utf8').replace(/--[^\n]*/g, '');
      for (const m of sql.matchAll(/\bDELETE\s+FROM\s+(\w+)/gi)) {
        const table = m[1]!;
        const triggers = guarded.get(table);
        if (!triggers) continue;
        const before = sql.slice(0, m.index);
        const after = sql.slice(m.index);
        if (new RegExp(`DROP TABLE (IF EXISTS )?${table}\\b`, 'i').test(before)) continue;
        const ok = [...triggers].some(
          (t) => new RegExp(`ALTER TABLE ${table} DISABLE TRIGGER ${t}\\b`, 'i').test(before) && new RegExp(`ALTER TABLE ${table} ENABLE TRIGGER ${t}\\b`, 'i').test(after),
        );
        if (!ok) problems.push(`${f}：DELETE FROM ${table}（要先 DISABLE TRIGGER ${[...triggers].join(' / ')}，删完 ENABLE）`);
      }
    }
    expect(problems).toEqual([]);
  });
});
