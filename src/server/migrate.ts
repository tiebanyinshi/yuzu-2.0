import { readdir, readFile } from 'node:fs/promises';
import type { Sql } from './db';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
const ADVISORY_LOCK = 918273645;

/** 迁移等表锁的上限：默认 30 秒；环境变量写错（不是「数字 + 可选单位」）按默认 */
export function migrationLockTimeout(raw = process.env.MIGRATION_LOCK_TIMEOUT): string {
  const v = raw?.trim() ?? '';
  return /^\d+\s*(ms|s|min|h)?$/.test(v) ? v : '30s';
}

/**
 * 不在事务里跑的迁移（8.1.54 数据库评估第 7 节）：第一行写 `-- yuzu:no-transaction`。给大表 CREATE INDEX CONCURRENTLY 这类不能放在事务里的语句用
 * （建索引时不挡写入）。规矩：只写简单语句，一句一个分号结尾、分号在行尾；不写 $$ 函数体；建索引前先 DROP INDEX CONCURRENTLY IF EXISTS
 * （上次建到一半失败会留下无效的索引）。按语句逐句执行，中途失败时已执行的不回滚，修好以后整份重跑（所以每句都要能重复执行）。
 */
export const NO_TRANSACTION_MARK = /^--\s*yuzu:no-transaction\b/;

export function splitSimpleStatements(content: string): string[] {
  const body = content
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  return body
    .split(/;[ \t]*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 按文件名顺序执行未应用的 SQL 迁移；用咨询锁避免多个进程同时迁移。
 * 普通迁移连着放在一个事务里（一份失败整批回滚）；碰到标了 no-transaction 的，先提交前面的，再单独逐句执行它，然后接着往下。
 */
export async function migrate(sql: Sql, log: (msg: string) => void = () => {}, opts: { dir?: URL } = {}): Promise<string[]> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  let i = 0;
  while (i < files.length) {
    // 一批普通迁移（到下一份没应用的 no-transaction 为止）
    let noTx: { file: string; content: string } | null = null;
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK})`;
      // 数据库评估（docs/DB_REVIEW_V8147.md 第 7 节）：迁移改表结构要表锁，前面有长事务时排着等，后面所有读写这张表的请求又排在它后面，
      // 整店卡住。等锁超过这个时长就放弃（整份迁移回滚、应用启动失败，由容器重启重试），不无限排队。拿到咨询锁以后才设：
      // 几个进程同时启动时，后来的照常等先来的迁移完。MIGRATION_LOCK_TIMEOUT 可调（PostgreSQL 的时长写法，如 30s、2min；0 = 不限）。
      await tx`SELECT set_config('lock_timeout', ${migrationLockTimeout()}, true)`;
      await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      const rows = await tx<{ version: string }[]>`SELECT version FROM schema_migrations`;
      const done = new Set(rows.map((r) => r.version));
      for (; i < files.length; i++) {
        const file = files[i]!;
        if (done.has(file)) continue;
        const content = await readFile(new URL(file, dir), 'utf8');
        if (NO_TRANSACTION_MARK.test(content)) {
          noTx = { file, content };
          break;
        }
        await tx.unsafe(content);
        await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
        applied.push(file);
        log(`已应用迁移 ${file}`);
      }
    });
    if (!noTx) break;
    const { file, content } = noTx as { file: string; content: string };
    await runWithoutTransaction(sql, file, content);
    applied.push(file);
    log(`已应用迁移 ${file}（不在事务里）`);
    i += 1;
  }
  return applied;
}

/** 单独占一条连接：会话级咨询锁、等锁上限，逐句执行（每句各自提交），最后登记 */
async function runWithoutTransaction(sql: Sql, file: string, content: string): Promise<void> {
  const conn = await sql.reserve();
  try {
    await conn`SELECT pg_advisory_lock(${ADVISORY_LOCK})`;
    try {
      const [seen] = await conn`SELECT 1 FROM schema_migrations WHERE version = ${file}`;
      if (seen) return;
      await conn`SELECT set_config('lock_timeout', ${migrationLockTimeout()}, false)`;
      for (const statement of splitSimpleStatements(content)) await conn.unsafe(statement);
      await conn`INSERT INTO schema_migrations (version) VALUES (${file})`;
    } finally {
      await conn`SELECT set_config('lock_timeout', '0', false)`;
      await conn`SELECT pg_advisory_unlock(${ADVISORY_LOCK})`;
    }
  } finally {
    conn.release();
  }
}
