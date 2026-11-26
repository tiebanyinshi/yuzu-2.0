import { readdir, readFile } from 'node:fs/promises';
import type { Sql } from './db';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

/** 迁移等表锁的上限：默认 30 秒；环境变量写错（不是「数字 + 可选单位」）按默认 */
export function migrationLockTimeout(raw = process.env.MIGRATION_LOCK_TIMEOUT): string {
  const v = raw?.trim() ?? '';
  return /^\d+\s*(ms|s|min|h)?$/.test(v) ? v : '30s';
}

/** 按文件名顺序执行未应用的 SQL 迁移；用咨询锁避免多个进程同时迁移。 */
export async function migrate(sql: Sql, log: (msg: string) => void = () => {}): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(918273645)`;
    // 数据库评估（docs/DB_REVIEW_V8147.md 第 7 节）：迁移改表结构要表锁，前面有长事务时排着等，后面所有读写这张表的请求又排在它后面，
    // 整店卡住。等锁超过这个时长就放弃（整份迁移回滚、应用启动失败，由容器重启重试），不无限排队。拿到咨询锁以后才设：
    // 几个进程同时启动时，后来的照常等先来的迁移完。MIGRATION_LOCK_TIMEOUT 可调（PostgreSQL 的时长写法，如 30s、2min；0 = 不限）。
    await tx`SELECT set_config('lock_timeout', ${migrationLockTimeout()}, true)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const rows = await tx<{ version: string }[]>`SELECT version FROM schema_migrations`;
    const done = new Set(rows.map((r) => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      const content = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
      applied.push(file);
      log(`已应用迁移 ${file}`);
    }
  });
  return applied;
}
