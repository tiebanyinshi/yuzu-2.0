-- 回滚 560_dining_v8224.sql（8.2.4 餐饮：分组默认档口、临时项目进厨房、包房房型、服务费门店默认、返台、公司承担）。
-- 先停服务、先备份；只在回到 8.2.4 以前的版本时执行。
-- 用过「公司承担」结账的结账单先反结账（或接受回滚失败）：旧版本不认识这种收款方式，约束会挡住；
-- 进了厨房的临时项目（kitchen_items.item_id 为空）先退掉或删掉出品单行，否则恢复 NOT NULL 会失败；
-- 自动记的房费明细留着（金额都在明细上），只去掉标记。服务费跟门店默认的桌（空）恢复成 0。
BEGIN;
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_company_check;
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_discount_check;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_discount_check
  CHECK ((method = 'discount') = (approved_by IS NOT NULL) AND (method = 'discount') = (grant_id IS NOT NULL) AND (method <> 'discount' OR char_length(btrim(ref)) >= 2));
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_method_check;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_method_check
  CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other', 'wallet', 'coupon', 'discount', 'store_coupon', 'member_discount', 'count_card', 'on_account'));
ALTER TABLE checkout_payments DROP COLUMN company_reason;
DELETE FROM auth_grants WHERE purpose = 'company_charge';
ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_purpose_check;
ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_purpose_check
  CHECK (purpose IN ('vip_tag', 'over_limit', 'checkout_discount', 'ticket_discount', 'member_refund', 'member_phone', 'line_void', 'checkin_risk'));
DROP TABLE table_session_returns;
UPDATE bill_lines SET charge_kind = NULL WHERE charge_kind = 'room_fee';
ALTER TABLE bill_lines DROP CONSTRAINT bill_lines_charge_kind_check;
ALTER TABLE bill_lines ADD CONSTRAINT bill_lines_charge_kind_check CHECK (charge_kind IN ('service_fee', 'min_spend'));
UPDATE dining_tables SET service_fee_bp = 0 WHERE service_fee_bp IS NULL;
ALTER TABLE dining_tables ALTER COLUMN service_fee_bp SET DEFAULT 0;
ALTER TABLE dining_tables ALTER COLUMN service_fee_bp SET NOT NULL;
ALTER TABLE dining_tables DROP COLUMN room_type_id;
DROP TABLE dining_room_types;
ALTER TABLE kitchen_items ALTER COLUMN item_id SET NOT NULL;
ALTER TABLE service_items DROP COLUMN station_pinned;
DELETE FROM schema_migrations WHERE version = '560_dining_v8224.sql';
COMMIT;
