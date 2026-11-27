-- 回滚 601_academy_assess.sql（汤崎学堂第二批：测评）。先停服务、先备份（题库、测验、每日一练、签核与证书都在这几张表里，回滚就删掉了）。
-- 602 要先回滚（它引用这里的表）。
BEGIN;
DROP TABLE IF EXISTS academy_certificates;
DROP TABLE IF EXISTS academy_signoffs;
DROP TABLE IF EXISTS academy_mastery;
DROP TABLE IF EXISTS academy_reviews;
DROP TABLE IF EXISTS academy_cards;
DROP TABLE IF EXISTS academy_attempts;
DROP FUNCTION IF EXISTS academy_attempt_guard();
DROP TABLE IF EXISTS academy_questions;
DELETE FROM position_suggestions WHERE permission = 'academy.coach';
DELETE FROM schema_migrations WHERE version = '601_academy_assess.sql';
COMMIT;
