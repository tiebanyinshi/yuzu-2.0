-- 回滚 312_kitchen_transfer.sql（8.1.39 消费转手牌）。先停服务、先备份；只在回到 8.1.39 以前的版本时执行。
-- 出品单的保护触发器恢复成 023 的写法（不许改指向的明细与来访）；已经转过的出品单照现在的指向留着。
BEGIN;
CREATE OR REPLACE FUNCTION yuzu_kitchen_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '出品单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.order_no, NEW.bill_line_id, NEW.visit_id, NEW.table_session_id, NEW.item_id, NEW.station_id, NEW.quantity, NEW.note,
      NEW.business_date, NEW.limit_taken, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.order_no, OLD.bill_line_id, OLD.visit_id, OLD.table_session_id, OLD.item_id, OLD.station_id, OLD.quantity,
      OLD.note, OLD.business_date, OLD.limit_taken, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION '出品单的菜品、数量与下单信息不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.rush_count < OLD.rush_count THEN
    RAISE EXCEPTION '催单次数不能减少' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'cancelled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION '已退的菜不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       NEW.status = 'cancelled'
    OR (OLD.status, NEW.status) IN (('queued', 'cooking'), ('queued', 'done'), ('cooking', 'done'), ('done', 'served'),
                                    ('cooking', 'queued'), ('done', 'cooking'), ('done', 'queued'), ('served', 'done'))
  ) THEN
    RAISE EXCEPTION '出品状态不能从 % 改为 %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DELETE FROM schema_migrations WHERE version = '312_kitchen_transfer.sql';
COMMIT;
