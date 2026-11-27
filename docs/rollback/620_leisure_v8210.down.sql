-- 回滚 620_leisure_v8210.sql：已有加钟记录（kind = 'extra'）时不能回滚（那几条明细要先作废并人工处理）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM space_usage_charges WHERE kind = 'extra') THEN
    RAISE EXCEPTION '已有加钟计费记录，不能回滚 620';
  END IF;
END $$;
ALTER TABLE space_usage_charges DROP CONSTRAINT space_usage_charges_kind_check;
ALTER TABLE space_usage_charges ADD CONSTRAINT space_usage_charges_kind_check CHECK (kind IN ('fee', 'open_fee'));
COMMENT ON COLUMN space_usage_charges.kind IS NULL;
DELETE FROM schema_migrations WHERE version = '620_leisure_v8210.sql';
