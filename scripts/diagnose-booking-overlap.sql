-- 前台自检「预约不重叠」报的技师预约重叠，逐对列出、每张写清有没有出处（只读；迁移 740 以后可用，设计见 docs/V8222_TECHNICIANS.md 第 11 节）。
--   PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/diagnose-booking-overlap.sql
-- 列的是自检会报的那些：同一位技师、时段有交叠、两张都还占着时段（待确认 / 已预约）、两张都没有一报多的标记。
-- 每张的「出处」：
--   · 一报多编号对得上但整批不全或不一致：编号与行号推得出来，可整批有一处对不上（原因写在后面），740 没有标，要人看；
--   · 单张新建：client_key 就是一条 booking_create 编号、编号记的就是这张——普通预约，真的重叠，按数据错误处理；
--   · 编号记成别的操作 / 找不到操作编号：导入、小程序、演示数据或别的入口建的，没有证据是一报多，740 不动。
-- 「570 以前」：这张预约建在 570（8.2.5）跑之前——标记加上之前的旧数据；570 以后建的不会是没标的一报多。
WITH links AS MATERIALIZED (
  SELECT * FROM yuzu_booking_batch_links()
), m570 AS (
  SELECT applied_at FROM schema_migrations WHERE version = '570_review_v825.sql'
), side AS (
  SELECT b.id, b.booking_no, b.technician_id, b.starts_at, b.ends_at, b.status, b.created_at,
         b.created_at < (SELECT applied_at FROM m570) AS before_570,
         CASE
           WHEN EXISTS (SELECT 1 FROM links l WHERE l.booking_id = b.id AND NOT l.confirmed)
             THEN '一报多编号对得上但整批不全或不一致：' || (SELECT string_agg(DISTINCT l.reason, '；') FROM links l WHERE l.booking_id = b.id)
           WHEN EXISTS (SELECT 1 FROM idempotency_keys k WHERE k.key = b.client_key AND k.op_type = 'booking_create' AND k.ref_id = b.id)
             THEN '单张新建（真的重叠）'
           WHEN EXISTS (SELECT 1 FROM idempotency_keys k WHERE k.key = b.client_key)
             THEN '编号记成别的操作'
           ELSE '找不到操作编号'
         END AS evidence
  FROM bookings b
  WHERE b.kind = 'technician' AND b.technician_id IS NOT NULL AND NOT b.technician_overlap AND b.status IN ('pending', 'confirmed')
)
SELECT a.booking_no AS booking_a, b.booking_no AS booking_b, t.tech_no, a.technician_id,
       a.starts_at AS a_starts_at, a.ends_at AS a_ends_at, b.starts_at AS b_starts_at, b.ends_at AS b_ends_at,
       a.created_at AS a_created_at, b.created_at AS b_created_at,
       a.before_570 AS a_before_570, b.before_570 AS b_before_570,
       a.evidence AS a_evidence, b.evidence AS b_evidence
FROM side a
JOIN side b ON b.id > a.id AND b.technician_id = a.technician_id AND b.starts_at < a.ends_at AND a.starts_at < b.ends_at
LEFT JOIN technicians t ON t.id = a.technician_id
ORDER BY a.starts_at, a.id, b.id;
