-- 数据库评估（8.1.47，docs/DB_REVIEW_V8147.md 第 2 节）：补上漏掉的门店外键。
-- 这 8 张表有 store_id（默认 yuzu_store()），建表时没写 REFERENCES stores：价目表的 5 张（230、232、233、237）、房态点单的 2 张（room_orders、room_order_outlets）、
-- 桌台事件 table_events。别的表的 store_id 都有外键，这几张写错门店号也拦不住。
-- 做法照 strong_migrations / GitLab 的「先 NOT VALID 再 VALIDATE」：加约束时不扫旧行（只拦新写入），再单独核对旧行。
-- 旧行里真有指向不存在的门店的（不应该有），不让整份迁移失败、发版卡住：那张表的约束留在 NOT VALID（新写入照样拦），打一条 WARNING，
-- 警告写在应用启动日志里（迁移在启动时执行），人工核对后照提示补 VALIDATE；tests/schema-health.test.ts 的 NOT VALID 白名单不收这几条，开发、测试库里必须是已核对的。
-- 门店表 stores 平时只有 FOR NO KEY UPDATE 的锁（docs/LOCKING.md），新外键要的 KEY SHARE 与它不冲突，不会多出锁等待。
-- 有意不加外键、写进评估报告第 2.3 节的：多态引用（ref_id、target_id、entity_id 等）、位置事件（只追加的遥测，035 有意不挂外键）、
-- 价目表操作记录里的 from_set_id / to_set_id（236 有意去掉：草稿、旧版本会删）、库存用量事件（不碰库存锁的设计）、最后一次移动的冗余指针。
-- 风险已知：只加约束不改数据；回滚见 docs/rollback/482_store_fks.down.sql。

DO $$
DECLARE
  t text;
  orphans bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_catalog_sets','price_catalog_import_ops','price_catalog_set_ops','price_catalog_links','price_catalog_link_ops','room_orders','room_order_outlets','table_events'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (store_id) REFERENCES stores (id) NOT VALID', t, t || '_store_id_fkey');
    EXECUTE format('SELECT count(*) FROM %I x WHERE NOT EXISTS (SELECT 1 FROM stores s WHERE s.id = x.store_id)', t) INTO orphans;
    IF orphans = 0 THEN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, t || '_store_id_fkey');
    ELSE
      RAISE WARNING '%: % 行的门店号不存在，外键先只拦新写入（NOT VALID），请人工核对后执行 ALTER TABLE % VALIDATE CONSTRAINT %', t, orphans, t, t || '_store_id_fkey';
    END IF;
  END LOOP;
END $$;
