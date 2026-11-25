-- 8.1.39（docs/V8139.md 第 5 节）：消费转手牌（《餐饮新店新系统功能需求文档》R11）——餐饮的菜也能转到另一张在店手牌，
-- 出品单跟着走（改指向新的明细与新的来访），厨房照常出、送到新手牌的客人。
-- 出品单的保护触发器原来不许改明细与来访；这里只在转单的事务里（SET LOCAL yuzu.kitchen_transfer = 'on'）放开这两列，别的照旧不许改。
-- 回滚：docs/rollback/312_kitchen_transfer.down.sql（恢复 023 的写法）。

CREATE OR REPLACE FUNCTION yuzu_kitchen_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '出品单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  -- 8.1.39 消费转手牌：只改指向的明细与来访（同一张桌台单不动），别的一样
  IF current_setting('yuzu.kitchen_transfer', true) = 'on'
     AND NEW.bill_line_id IS DISTINCT FROM OLD.bill_line_id AND NEW.visit_id IS NOT NULL AND OLD.visit_id IS NOT NULL
     AND (NEW.id, NEW.order_no, NEW.table_session_id, NEW.item_id, NEW.station_id, NEW.quantity, NEW.note,
          NEW.business_date, NEW.limit_taken, NEW.created_by, NEW.created_at, NEW.status, NEW.rush_count)
         IS NOT DISTINCT FROM (OLD.id, OLD.order_no, OLD.table_session_id, OLD.item_id, OLD.station_id, OLD.quantity,
          OLD.note, OLD.business_date, OLD.limit_taken, OLD.created_by, OLD.created_at, OLD.status, OLD.rush_count)
     AND OLD.status <> 'cancelled' THEN
    RETURN NEW;
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
