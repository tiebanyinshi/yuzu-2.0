-- 8.1.44（docs/V8144_FRONTDESK.md 第 1 条，《前台系统开发》「已发券使用条件支持后台修改」）：
-- 发过券的模板，「使用条件」可以改、改了马上生效（结账时按模板此刻的条件核对）：门槛、适用范围（全部 / 部门 / 项目）。
-- 星期、时段、门店、点钟券（8.1.40，320）本来就不在这个触发器里，由服务端放开。
-- 仍然锁着：种类、面额、几折、最多减（抵）、兑换 / 买赠的项目、有效期、限定发放档级——这些是已经许给客人的钱和东西，
-- 改了等于改已发的券，照旧另建模板。
-- 回滚：docs/rollback/360_coupon_usage_terms.down.sql。

CREATE OR REPLACE FUNCTION yuzu_coupon_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '券模板不能删除，请停用' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.created_by, NEW.created_at, NEW.client_key) IS DISTINCT FROM (OLD.id, OLD.created_by, OLD.created_at, OLD.client_key) THEN
    RAISE EXCEPTION '券模板的建档信息不能改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.kind, NEW.face_value, NEW.rate_percent, NEW.max_off,
      NEW.exchange_item_id, NEW.exchange_ticket_type_id, NEW.validity, NEW.valid_from, NEW.valid_to, NEW.valid_days, NEW.levels, NEW.buy_item_id)
     IS DISTINCT FROM
     (OLD.kind, OLD.face_value, OLD.rate_percent, OLD.max_off,
      OLD.exchange_item_id, OLD.exchange_ticket_type_id, OLD.validity, OLD.valid_from, OLD.valid_to, OLD.valid_days, OLD.levels, OLD.buy_item_id)
     AND EXISTS (SELECT 1 FROM coupons WHERE template_id = OLD.id) THEN
    RAISE EXCEPTION '这个模板已经发过券，面额、折扣、兑换的项目、有效期、档级不能改，请另建模板' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
