-- 回滚 600_academy_core.sql（汤崎学堂第一批）。先停服务、先备份（课程、学习记录与学分都在这几张表里，回滚就删掉了）。
-- 601、602 要先回滚（它们引用这里的表）。
BEGIN;
DROP TABLE IF EXISTS academy_feedback;
DROP TABLE IF EXISTS academy_credits;
DROP TABLE IF EXISTS academy_study_days;
DROP TABLE IF EXISTS academy_progress;
DROP TABLE IF EXISTS academy_assignments;
DROP TABLE IF EXISTS academy_path_courses;
DROP TABLE IF EXISTS academy_paths;
DROP TABLE IF EXISTS academy_lessons;
DROP TABLE IF EXISTS academy_courses;
DELETE FROM position_suggestions WHERE permission = 'academy.manage';
DELETE FROM schema_migrations WHERE version = '600_academy_core.sql';
COMMIT;
