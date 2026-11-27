-- 8.2.17 之后（不改版本号，随下一个版本标签发；设计见 docs/V8222_TECHNICIANS.md 第 11 节）：8.2.4 的一报多建的技师预约补上「有意重叠」标记。
-- 来由：570（8.2.5）加 bookings.technician_overlap 时历史预约一律是 false；8.2.4 的一报多（8.2.2 写的，8.2.0 → 8.2.4 之间没有单独发版）
-- 有意让同一位技师同一时段约几位，升级后前台自检「预约不重叠」把这些当成数据错误。570 已发布，不改；这里补。
--
-- 只认出处，不猜：8.2.4 的一报多（与现在一样）整批一个操作编号 K，记在 idempotency_keys（op_type = booking_create，ref_id = 第 1 行的预约，
-- staff_id = 经办人），第 i 行（从 0 数，最多 10 行）预约的 client_key = batchRowKey(K, i)
-- = sha256('booking-batch:' || K || ':' || i) 摆成 UUID 的样子（第 13 位写 4、第 17 位取低 2 位再或 8，与 bookings.ts 的 batchRowKey 逐字一致）。
-- 一批算「确认是一报多」要同时满足：行号从 0 连续、第 0 行就是编号记的 ref_id、每行都是技师预约、经办人与编号的一致、
-- 来源是前台 / 电话、没有会员、1 位客人（一报多只会这样建）。现在的代码给一报多的技师预约一律写 true（8.2.4 的规则与现在一样，
-- 只少了 8.2.5 加的「技师预约」权限核对——那是谁能建，不是写不写标记），所以确认了的整批都标上。
-- 同一技师、同一时段、建的时间挨着都不算证据；编号对不上、不全的一行不动，前台自检照旧报，用 scripts/diagnose-booking-overlap.sql 列出来。
-- idempotency_keys 只追加（001 的 yuzu_forbid_mutation 触发器，8.1.47 的归档任务也不碰它），8.2.4 写的编号都还在。
--
-- 风险已知：只把确认是一报多、还是 false 的预约改成 true，别的列（时间、状态、版本号）都不动；每改一张记一条审计（booking_overlap_backfill，
-- 经办人为空、detail 写整批编号与行号）。可以重复执行：第二次没有要改的、也不再记审计。回滚见 docs/rollback/740_booking_batch_overlap.down.sql。

CREATE OR REPLACE FUNCTION yuzu_booking_batch_row_key(batch_key uuid, idx integer) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-'
          || to_hex((('x' || substr(h, 17, 1))::bit(4)::int & 3) | 8) || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
  FROM (SELECT encode(sha256(convert_to('booking-batch:' || batch_key::text || ':' || idx::text, 'UTF8')), 'hex') AS h) s
$$;
COMMENT ON FUNCTION yuzu_booking_batch_row_key(uuid, integer) IS
  '一报多整批编号推出第 idx 行预约的 client_key（与 src/server/modules/bookings.ts 的 batchRowKey 一致；迁移 740）';

CREATE OR REPLACE FUNCTION yuzu_booking_batch_links()
RETURNS TABLE (batch_key uuid, row_index integer, booking_id bigint, confirmed boolean, reason text)
LANGUAGE sql STABLE AS $$
  WITH linked AS (
    SELECT k.key AS batch_key, i.n AS row_index, k.ref_id, k.staff_id,
           b.id AS booking_id, b.kind, b.created_by, b.source, b.member_id, b.guests
    FROM idempotency_keys k
    CROSS JOIN generate_series(0, 9) AS i(n)
    JOIN bookings b ON b.client_key = yuzu_booking_batch_row_key(k.key, i.n)
    WHERE k.op_type = 'booking_create'
  ), batches AS (
    SELECT l.batch_key,
           count(*) = max(l.row_index) + 1 AS contiguous,
           bool_or(l.row_index = 0 AND l.booking_id = l.ref_id) AS first_is_ref,
           bool_and(l.kind = 'technician') AS all_technician,
           bool_and(l.created_by = l.staff_id) AS same_staff,
           bool_and(l.source IN ('front', 'phone') AND l.member_id IS NULL AND l.guests = 1) AS batch_shape
    FROM linked l
    GROUP BY l.batch_key
  )
  SELECT l.batch_key, l.row_index, l.booking_id,
         c.contiguous AND c.first_is_ref AND c.all_technician AND c.same_staff AND c.batch_shape,
         concat_ws('；',
           CASE WHEN NOT c.contiguous THEN '行号不连续' END,
           CASE WHEN NOT c.first_is_ref THEN '第 0 行不是编号记的那张' END,
           CASE WHEN NOT c.all_technician THEN '有不是技师预约的行' END,
           CASE WHEN NOT c.same_staff THEN '经办人与编号的不一致' END,
           CASE WHEN NOT c.batch_shape THEN '来源、会员或人数不像一报多' END)
  FROM linked l JOIN batches c USING (batch_key)
$$;
COMMENT ON FUNCTION yuzu_booking_batch_links() IS
  '按操作编号（idempotency_keys.booking_create）找出一报多建的预约与整批是否对得上（confirmed）；迁移 740 与 scripts/diagnose-booking-overlap.sql 共用';

WITH flagged AS (
  UPDATE bookings b SET technician_overlap = true
  FROM yuzu_booking_batch_links() l
  WHERE l.booking_id = b.id AND l.confirmed AND b.kind = 'technician' AND NOT b.technician_overlap
  RETURNING b.id, b.booking_no, b.store_id, b.business_date, l.batch_key, l.row_index
)
INSERT INTO audit_logs (staff_id, action, target_type, target_id, detail, business_date, store_id)
SELECT NULL, 'booking_overlap_backfill', 'booking', f.id::text,
       jsonb_build_object('bookingNo', f.booking_no, 'batchKey', f.batch_key, 'row', f.row_index, 'migration', '740_booking_batch_overlap.sql'),
       f.business_date, f.store_id
FROM flagged f;
