// 库结构的体检（8.1.47 数据库评估，docs/DB_REVIEW_V8147.md 第 7 节；思路照 Supabase splinter、GitLab 的数据库规范）：
// 在迁移都跑完的库上核对，以后的新迁移照这些规则来，违反了直接指出是哪张表、哪一列。
//   ① 每张表有主键；② 每个外键有以它打头的索引（指向 staff、stores 的例外）；③ 每张表有库内注释；
//   ④ 没有完全重复的索引；⑤ 没核对过的约束（NOT VALID）只有白名单里的；⑥ 以 _id 结尾、却没挂外键的列只有白名单里的；
//   ⑦ 归档表与原表同列（多一列 archived_at）；⑧ docs/DATA_DICTIONARY.md 与库一致；
//   ⑨（8.1.52）带门店默认值的表不在事务外直接用连接池写（多门店时会落到本店）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARCHIVED_TABLES } from '../src/server/modules/archive';
// @ts-expect-error 生成脚本是 .mjs，没有类型声明
import { DICTIONARY_PATH, renderDictionary } from '../scripts/gen-data-dictionary.mjs';
import { setup, type TestContext } from './helpers';

/** 外键可以不建索引的父表：主数据，代码里从不删、主键不改（按员工、按门店查的各模块有自己的复合索引） */
const FK_INDEX_EXEMPT_PARENTS = ['staff', 'stores'];

/** 有意保留 NOT VALID 的约束：017 只约束新写入的「其他」收款要写说明，旧数据不回改 */
const NOT_VALID_ALLOWED = ['checkout_payments.checkout_payments_other_note_check'];

/**
 * 以 _id 结尾、有意不挂外键的列（评估报告第 2.3 节逐类说明）：多态引用（ref_id、target_id、entity_id、owner_id、doc_id）、
 * 外部系统的编号（微信、前端设备）、位置遥测（035 有意不挂）、价目表操作记录（236 有意去掉）、库存用量事件（不碰库存锁）、
 * 冗余的「最后一次」指针、小程序线的表、请求编号（audit_logs.request_id，490，不是库里的行）。新加的 _id 列要么挂外键，要么加到这里并在报告里写明为什么。归档表 archived_* 一律不挂外键，不列。
 */
const ID_WITHOUT_FK_ALLOWED = new Set(
  `approval_logs.doc_id approval_requests.doc_id audit_logs.request_id audit_logs.target_id bank_matches.target_id canteen_likes.dish_id concierge_operations.request_id
  concierge_revisions.object_id current_locations.floor_id current_locations.space_id current_locations.technician_id current_locations.visit_id
  current_locations.zone_id custom_field_values.entity_id entry_claims.ref_id erp_drafts.last_save_id erp_drafts.ref_id gf_files.owner_id
  idempotency_keys.ref_id integration_calls.ref_id inv_doc_lines.book_move_id invoice_requests.source_id location_events.device_id
  location_events.floor_id location_events.reader_id location_events.ref_id location_events.space_id location_events.staff_id
  location_events.technician_id location_events.visit_id location_events.zone_id location_tracks.floor_id location_tracks.space_id
  location_tracks.technician_id location_tracks.visit_id location_tracks.zone_id materials.last_move_id mp_booking_ops.member_id
  mp_food_orders.member_id mp_recharge_orders.prepay_id mp_recharge_orders.transaction_id mp_refund_orders.transaction_id
  mp_refund_orders.wx_refund_id mp_reminder_consents.template_id oa_attachments.ref_id oa_im_members.last_read_message_id oa_leave_entries.ref_id
  oa_notifications.ref_id oa_payroll_files.key_id pay_transactions.consumed_id pay_tx_events.target_id payment_batch_items.payment_id
  price_catalog_set_ops.from_set_id price_catalog_set_ops.to_set_id stock_usage_batches.warehouse_id stock_usage_events.bill_line_id
  stock_usage_events.item_id stock_usage_events.material_id stock_usage_events.warehouse_id studio_comments.node_id technician_announcer.client_id
  warehouse_stock.last_move_id`.split(/\s+/),
);

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx?.close());

const list = async (q: Promise<{ x: string }[]>) => (await q).map((r) => r.x);

describe('库结构体检', () => {
  it('① 每张表有主键', async () => {
    const rows = await list(ctx.sql`
      SELECT c.relname AS x FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')
      ORDER BY 1`);
    expect(rows, '这些表没有主键').toEqual([]);
  });

  it('② 外键都有以它打头的索引（指向员工、门店的除外）', async () => {
    const rows = await list(ctx.sql`
      SELECT k.conrelid::regclass::text || '.' || k.conname || ' → ' || k.confrelid::regclass::text AS x
      FROM pg_constraint k
      WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace
        AND k.confrelid::regclass::text <> ALL (${FK_INDEX_EXEMPT_PARENTS})
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = k.conrelid
            AND (i.indkey::int2[])[0:array_length(k.conkey, 1) - 1] @> k.conkey
            AND (i.indkey::int2[])[0:array_length(k.conkey, 1) - 1] <@ k.conkey)
      ORDER BY 1`);
    expect(rows, '这些外键没有以它打头的索引：在同一份迁移里 CREATE INDEX（可空的列建 WHERE 列 IS NOT NULL 的部分索引）').toEqual([]);
  });

  it('③ 每张表有库内注释（COMMENT ON TABLE）', async () => {
    const rows = await list(ctx.sql`
      SELECT c.relname AS x FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND obj_description(c.oid, 'pg_class') IS NULL
      ORDER BY 1`);
    expect(rows, '这些表没有注释：建表的迁移里写 COMMENT ON TABLE，再重新生成数据字典').toEqual([]);
  });

  it('④ 没有完全重复的索引', async () => {
    const rows = await list(ctx.sql`
      SELECT string_agg(i.indexrelid::regclass::text, ' = ' ORDER BY i.indexrelid::regclass::text) AS x
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      WHERE c.relnamespace = 'public'::regnamespace
      GROUP BY i.indrelid, i.indkey::text, i.indclass::text, coalesce(pg_get_expr(i.indexprs, i.indrelid), ''), coalesce(pg_get_expr(i.indpred, i.indrelid), '')
      HAVING count(*) > 1
      ORDER BY 1`);
    expect(rows, '这些索引的列、写法、条件完全一样，留一个').toEqual([]);
  });

  it('⑤ 没核对过的约束（NOT VALID）只有白名单里的', async () => {
    const rows = await list(ctx.sql`
      SELECT k.conrelid::regclass::text || '.' || k.conname AS x FROM pg_constraint k
      WHERE k.connamespace = 'public'::regnamespace AND NOT k.convalidated ORDER BY 1`);
    expect(
      rows.filter((r) => !NOT_VALID_ALLOWED.includes(r)),
      '这些约束还是 NOT VALID：加完以后在迁移里 VALIDATE CONSTRAINT',
    ).toEqual([]);
  });

  it('⑥ 以 _id 结尾的列都挂了外键（白名单里有意不挂的除外）', async () => {
    const rows = await list(ctx.sql`
      SELECT c.relname || '.' || a.attname AS x
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attname ~ '_id$'
        AND c.relname !~ '^archived_'
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid = c.oid AND a.attnum = ANY (k.conkey))
      ORDER BY 1`);
    expect(
      rows.filter((r) => !ID_WITHOUT_FK_ALLOWED.has(r)),
      '这些 _id 列没有外键：挂上 REFERENCES，或有意不挂的加进白名单、评估报告里写明',
    ).toEqual([]);
    // 白名单里已经挂上外键（或已删掉）的，从白名单里拿掉，免得越积越多
    expect(
      [...ID_WITHOUT_FK_ALLOWED].filter((x) => !rows.includes(x)),
      '白名单里这些已经不需要了',
    ).toEqual([]);
  });

  it('⑦ 归档表与原表同列，只多 archived_at', async () => {
    const colsOf = async (t: string) =>
      list(ctx.sql`
        SELECT a.attname || ' ' || format_type(a.atttypid, a.atttypmod) AS x FROM pg_attribute a
        WHERE a.attrelid = ${t}::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
    for (const [archived, source] of Object.entries(ARCHIVED_TABLES)) {
      expect(await colsOf(archived), `${archived} 与 ${source} 的列不一致：原表加了列，同一份迁移里给归档表也加上`).toEqual([...(await colsOf(source)), 'archived_at timestamp with time zone']);
    }
  });

  it('⑧ 数据字典与库一致', async () => {
    const want = await renderDictionary(ctx.sql);
    const have = readFileSync(new URL(`../${DICTIONARY_PATH}`, import.meta.url), 'utf8');
    expect(have === want, `${DICTIONARY_PATH} 不是最新的：照 scripts/gen-data-dictionary.mjs 开头的命令重新生成`).toBe(true);
  });

  it('⑨ 带门店默认值的表不在事务外直接用连接池写（多门店：池上的写入拿不到请求的门店，会落到本店）', async () => {
    const tables = await list(ctx.sql`
      SELECT table_name AS x FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'store_id' AND column_default LIKE '%yuzu_store()%'`);
    const re = new RegExp(String.raw`\b(?:sql|deps\.sql)\`\s*INSERT INTO (${tables.join('|')})\b`, 'g');
    const root = new URL('../src/server/', import.meta.url).pathname;
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
    const hits = walk(root).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(re)].map((m) => `${f.slice(root.length)}：${m[1]}`));
    expect(hits, '这些写入直接用连接池，门店会落到本店：放进 sql.begin 事务里（事务开头记上当前门店），或显式写 store_id').toEqual([]);
  });
});
