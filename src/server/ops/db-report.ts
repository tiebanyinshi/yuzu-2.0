// 数据库体检报告（8.1.54，数据库评估 docs/DB_REVIEW_V8147.md 第 10 节 P2）：`node dist/server/cli.js db-report`
//   · 最慢的查询（要 pg_stat_statements：compose.yaml 里数据库已预加载，迁移 491 建扩展；没有时这一段跳过并说明）；
//   · 没用过的索引（idx_scan = 0，不含主键与唯一约束：那些是约束，不能删），按大小排——跑满一个营业周期以后再看，删之前在报告里写明；
//   · 最大的表。
// 只读。统计从数据库上次重启（或 pg_stat_reset）算起。

import type { Sql } from '../db';

export interface DbReport {
  since: string | null;
  statements: { available: boolean; reason?: string; top: { calls: number; meanMs: number; totalMs: number; query: string }[] };
  unusedIndexes: { table: string; index: string; size: string }[];
  largestTables: { table: string; rows: number; size: string }[];
}

export async function dbReport(sql: Sql, limit = 15): Promise<DbReport> {
  const [since] = await sql<{ at: Date | null }[]>`SELECT stats_reset AS at FROM pg_stat_database WHERE datname = current_database()`;
  let statements: DbReport['statements'] = { available: false, top: [] };
  const [ext] = await sql<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS ok`;
  if (!ext?.ok) statements.reason = '没有 pg_stat_statements 扩展（迁移 491 建不了时会在启动日志里说明）';
  else {
    try {
      const top = await sql<{ calls: number; meanMs: number; totalMs: number; query: string }[]>`
        SELECT calls::bigint AS calls, round(mean_exec_time::numeric, 1)::float AS mean_ms, round(total_exec_time::numeric)::float AS total_ms,
               left(regexp_replace(query, '\\s+', ' ', 'g'), 300) AS query
        FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        ORDER BY total_exec_time DESC LIMIT ${limit}`;
      statements = { available: true, top: top.map((r) => ({ ...r, calls: Number(r.calls) })) };
    } catch (error) {
      statements.reason = `pg_stat_statements 没有预加载（数据库要带 shared_preload_libraries=pg_stat_statements 启动）：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const unusedIndexes = await sql<{ table: string; index: string; size: string }[]>`
    SELECT s.relname AS table, s.indexrelname AS index, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
    FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
    WHERE s.schemaname = 'public' AND s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
    ORDER BY pg_relation_size(s.indexrelid) DESC, s.indexrelname LIMIT ${limit * 4}`;
  const largestTables = await sql<{ table: string; rows: number; size: string }[]>`
    SELECT c.relname AS table, c.reltuples::bigint AS rows, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    ORDER BY pg_total_relation_size(c.oid) DESC LIMIT ${limit}`;
  return {
    since: since?.at ? new Date(since.at).toISOString() : null,
    statements,
    unusedIndexes,
    largestTables: largestTables.map((t) => ({ ...t, rows: Math.max(0, Number(t.rows)) })),
  };
}

export function formatDbReport(r: DbReport): string {
  const out: string[] = [`统计起点：${r.since ?? '数据库启动时'}`, '', '■ 最耗时的查询（按累计耗时）'];
  if (!r.statements.available) out.push(`  （没有：${r.statements.reason}）`);
  for (const q of r.statements.top) out.push(`  ${q.totalMs} 毫秒 / ${q.calls} 次 / 平均 ${q.meanMs} 毫秒  ${q.query}`);
  out.push('', `■ 没用过的索引（${r.unusedIndexes.length} 个；跑满一个营业周期再看，删之前在评估报告里写明）`);
  for (const i of r.unusedIndexes) out.push(`  ${i.size.padStart(8)}  ${i.table}.${i.index}`);
  out.push('', '■ 最大的表');
  for (const t of r.largestTables) out.push(`  ${t.size.padStart(8)}  ${t.table}（约 ${t.rows} 行）`);
  return out.join('\n');
}
