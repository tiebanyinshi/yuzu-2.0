// 热表归档（8.1.47，数据库评估 docs/DB_REVIEW_V8147.md 第 5 节，迁移 483）：只增不减、又只在近期有用的流水型记录，超过保留天数的挪进 archived_* 表。
// 每小时跑一次（jobs.ts），每类每次最多挪 BATCH × MAX_BATCHES 行、每批一个短事务，不长时间占锁；挪不完的下一小时接着挪。
// 挪 = 同一事务里 DELETE … RETURNING 再 INSERT 进归档表（原编号不变），原表只追加的触发器只在 SET LOCAL yuzu.archiving = 'on' 时放行 DELETE。
// 账本、单据、审计日志不在这里：只追加、永久保留。

import { every } from '../lib/throttle';
import type { ArchiveConfig } from '../config';
import type { Sql, Tx } from '../db';
import { setTxTimeouts } from '../lib/tx';

export const ARCHIVE_BATCH = 2000;
const MAX_BATCHES = 10;

/** 归档表 → 原表 */
export const ARCHIVED_TABLES = {
  archived_location_events: 'location_events',
  archived_location_tracks: 'location_tracks',
  archived_integration_calls: 'integration_calls',
  archived_wecom_pushes: 'wecom_pushes',
} as const;
type ArchivedTable = keyof typeof ARCHIVED_TABLES;

export interface ArchiveRun {
  locationTracks: number;
  locationEvents: number;
  integrationCalls: number;
  wecomPushes: number;
}

const columnCache = new Map<string, string>();
/** 原表的列（按列序），挪的时候两边都写明列名；归档表比原表多 archived_at（tests/schema-health.test.ts 核对两边一致） */
async function columnsOf(tx: Tx, table: string): Promise<string> {
  const hit = columnCache.get(table);
  if (hit) return hit;
  const rows = await tx<{ name: string }[]>`
    SELECT a.attname AS name FROM pg_attribute a
    WHERE a.attrelid = ${table}::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`;
  const list = rows.map((r) => `"${r.name}"`).join(', ');
  columnCache.set(table, list);
  return list;
}

/** 挪一批：pick 是选出要挪的编号的子查询（已限制条数）；返回挪了几行 */
async function moveBatch(sql: Sql, archived: ArchivedTable, pick: (tx: Tx) => PromiseLike<readonly { id: number | string }[]>): Promise<number> {
  const source = ARCHIVED_TABLES[archived];
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await tx`SELECT set_config('yuzu.archiving', 'on', true)`;
    const ids = (await pick(tx)).map((r) => Number(r.id));
    if (!ids.length) return 0;
    const cols = await columnsOf(tx, source);
    const [row] = await tx.unsafe<{ n: number }[]>(
      `WITH moved AS (DELETE FROM ${source} WHERE id = ANY($1::bigint[]) RETURNING ${cols})
       , ins AS (INSERT INTO ${archived} (${cols}) OVERRIDING SYSTEM VALUE SELECT ${cols} FROM moved RETURNING 1)
       SELECT count(*)::int AS n FROM ins`,
      [ids],
    );
    return row!.n;
  }) as Promise<number>;
}

async function drain(fn: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await fn();
    total += n;
    if (n < ARCHIVE_BATCH) break;
  }
  return total;
}

/** 挪一轮（不管间隔，用例直接调）；now 决定截止时刻 */
export async function archiveOnce(sql: Sql, cfg: ArchiveConfig, now: Date = new Date()): Promise<ArchiveRun> {
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const run: ArchiveRun = { locationTracks: 0, locationEvents: 0, integrationCalls: 0, wecomPushes: 0 };
  if (cfg.locationDays > 0) {
    const cut = before(cfg.locationDays);
    // 先挪轨迹段（它引用事件）：结束得早、不是谁的当前段的
    run.locationTracks = await drain(() =>
      moveBatch(
        sql,
        'archived_location_tracks',
        (tx) => tx<{ id: number }[]>`
          SELECT t.id FROM location_tracks t
          WHERE t.left_at < ${cut} AND NOT EXISTS (SELECT 1 FROM current_locations c WHERE c.track_id = t.id)
          ORDER BY t.id LIMIT ${ARCHIVE_BATCH}`,
      ),
    );
    // 再挪事件：早于截止、没有留下的轨迹段与当前位置还引用着的
    run.locationEvents = await drain(() =>
      moveBatch(
        sql,
        'archived_location_events',
        (tx) => tx<{ id: number }[]>`
          SELECT e.id FROM location_events e
          WHERE e.at < ${cut} AND e.recorded_at < ${cut}
            AND NOT EXISTS (SELECT 1 FROM current_locations c WHERE c.last_event_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM location_tracks t WHERE t.first_event_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM location_tracks t WHERE t.last_event_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM location_tracks t WHERE t.end_event_id = e.id)
          ORDER BY e.id LIMIT ${ARCHIVE_BATCH}`,
      ),
    );
  }
  if (cfg.integrationCallDays > 0) {
    const cut = before(cfg.integrationCallDays);
    run.integrationCalls = await drain(() =>
      moveBatch(sql, 'archived_integration_calls', (tx) => tx<{ id: number }[]>`SELECT id FROM integration_calls WHERE created_at < ${cut} ORDER BY id LIMIT ${ARCHIVE_BATCH}`),
    );
  }
  if (cfg.wecomPushDays > 0) {
    const cut = before(cfg.wecomPushDays);
    run.wecomPushes = await drain(() =>
      moveBatch(sql, 'archived_wecom_pushes', (tx) => tx<{ id: number }[]>`SELECT id FROM wecom_pushes WHERE status IN ('sent', 'failed') AND created_at < ${cut} ORDER BY id LIMIT ${ARCHIVE_BATCH}`),
    );
  }
  return run;
}

const archiveDue = every(60 * 60 * 1000);
/** 每小时一次（每个进程各自计时；几个进程同时挪，同一行只会被一个删掉，另一个的那批挪 0 行） */
export async function runHotTableArchive(sql: Sql, cfg: ArchiveConfig, now = Date.now()): Promise<ArchiveRun | null> {
  if (!archiveDue(now)) return null;
  return archiveOnce(sql, cfg, new Date(now));
}
