-- 回滚 360_coupon_usage_terms.sql（8.1.44 已发券改使用条件）。先停服务、先备份；只在回到 8.1.44 以前的版本时执行。
-- 恢复 089 的保护：发过券的模板门槛、适用范围又不能改；已经改过的模板保持改后的样子（回滚不改数据）。
BEGIN;
CREATE OR REPLACE FUNCTION yuzu_coupon_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '券模板不能删除，请停用' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.created_by, NEW.created_at, NEW.client_key) IS DISTINCT FROM (OLD.id, OLD.created_by, OLD.created_at, OLD.client_key) THEN
    RAISE EXCEPTION '券模板的建档信息不能改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.kind, NEW.face_value, NEW.rate_percent, NEW.max_off, NEW.threshold, NEW.scope, NEW.scope_categories, NEW.scope_items,
      NEW.exchange_item_id, NEW.exchange_ticket_type_id, NEW.validity, NEW.valid_from, NEW.valid_to, NEW.valid_days, NEW.levels, NEW.buy_item_id)
     IS DISTINCT FROM
     (OLD.kind, OLD.face_value, OLD.rate_percent, OLD.max_off, OLD.threshold, OLD.scope, OLD.scope_categories, OLD.scope_items,
      OLD.exchange_item_id, OLD.exchange_ticket_type_id, OLD.validity, OLD.valid_from, OLD.valid_to, OLD.valid_days, OLD.levels, OLD.buy_item_id)
     AND EXISTS (SELECT 1 FROM coupons WHERE template_id = OLD.id) THEN
    RAISE EXCEPTION '这个模板已经发过券，面额、折扣、门槛、范围、有效期不能改，请另建模板' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DELETE FROM schema_migrations WHERE version = '360_coupon_usage_terms.sql';
COMMIT;
