-- 回滚 216_oa_face.sql（OA-07 人脸录入与审核）：删人脸录入表与照片、打卡上的人脸结果与自拍。
BEGIN;
DELETE FROM oa_attachments WHERE ref_type IN ('oa_face', 'oa_punch_face');
DROP TABLE IF EXISTS oa_face_enrollments;
ALTER TABLE oa_punches DROP COLUMN IF EXISTS face_result;
DELETE FROM schema_migrations WHERE version = '216_oa_face.sql';
COMMIT;
