-- OA-07 人脸录入与审核（docs/OA.md 第 10 节；需求文档四（四）第 3 条）。
--   · oa_face_enrollments：员工每提交一次一行（3 张照片挂在 oa_attachments 上，ref_type = 'oa_face'）。
--     status：pending 待审核 → approved 已通过 / rejected 被退回；approved 的可以 revoked 停用，
--     新的一份审核通过时旧的那份记 replaced。只改状态与审核人，不删行。
--     同一人同时只有一份待审核、一份已通过（部分唯一索引）。人脸跟人走，不按门店分。
--   · oa_punches.face_result：打卡时的人脸比对结果（pass 通过 / pending 比对服务没配置或不可用、待人工核对）；
--     不要人脸的组为空。比对不通过、没录人脸的不让打卡，不会留下记录。
-- 提交人脸录入、审核带操作编号：操作编号与「确认作废」多两类 oa_face_enroll、oa_face_review（在当时的约束上追加）。
-- 回滚：docs/rollback/216_oa_face.down.sql。

CREATE TABLE oa_face_enrollments (
  id            bigserial PRIMARY KEY,
  staff_id      bigint NOT NULL REFERENCES staff (id),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'revoked', 'replaced')),
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_by   bigint REFERENCES staff (id),
  reviewed_at   timestamptz,
  review_note   text CHECK (review_note IS NULL OR char_length(review_note) <= 200),
  CHECK ((status = 'pending') = (reviewed_at IS NULL))
);
CREATE UNIQUE INDEX oa_face_enrollments_one_pending ON oa_face_enrollments (staff_id) WHERE status = 'pending';
CREATE UNIQUE INDEX oa_face_enrollments_one_approved ON oa_face_enrollments (staff_id) WHERE status = 'approved';
CREATE INDEX oa_face_enrollments_status_idx ON oa_face_enrollments (status, submitted_at);

ALTER TABLE oa_punches ADD COLUMN face_result text CHECK (face_result IN ('pass', 'pending'));

DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''oa_face_enroll'', ''oa_face_review''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
