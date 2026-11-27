-- 汤崎学堂第三批：课件与 AI（店主 2026-11-27，docs/ACADEMY.md 第 5、6、9 节，PENDING_DECISIONS XT10–XT12）：
--   · 批量操作（导入内置课件包、从表格导入题、AI 出题）：一次一行，带操作编号与原请求摘要；没收到结果原样重提返回第一次的结果；
--   · 问柚子：员工在课程里问的问题与回答（只按这门课的课件回答，记下引用了哪几个课时），每人每天有上限。
-- 回滚：docs/rollback/602_academy_content.down.sql。

CREATE TABLE academy_bulk_ops (
  id           bigserial PRIMARY KEY,
  client_key   uuid NOT NULL UNIQUE,
  kind         text NOT NULL CHECK (kind IN ('pack_import', 'question_import', 'ai_questions')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  result       jsonb,
  error        text CHECK (char_length(error) <= 500),
  created_by   bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX academy_bulk_ops_created_idx ON academy_bulk_ops (created_at);
COMMENT ON TABLE academy_bulk_ops IS '学堂的批量操作（导入内置课件包、表格导入题、AI 出题）：带操作编号与原请求摘要，原样重提返回第一次的结果';
COMMENT ON COLUMN academy_bulk_ops.result IS '做完的结果（导入了哪些课、建了哪些题）';

CREATE TABLE academy_tutor_questions (
  id            bigserial PRIMARY KEY,
  staff_id      bigint NOT NULL REFERENCES staff (id),
  course_id     bigint NOT NULL REFERENCES academy_courses (id),
  client_key    uuid NOT NULL UNIQUE,
  question      text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  answer        text CHECK (char_length(answer) <= 2000),
  sources       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  status        text NOT NULL DEFAULT 'answering' CHECK (status IN ('answering', 'done', 'failed', 'unconfigured')),
  model         text,
  input_tokens  integer,
  output_tokens integer,
  error         text CHECK (char_length(error) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX academy_tutor_questions_staff_idx ON academy_tutor_questions (staff_id, created_at);
CREATE INDEX academy_tutor_questions_course_idx ON academy_tutor_questions (course_id);
COMMENT ON TABLE academy_tutor_questions IS '问柚子（学堂 AI 助教）：只按这门课的课件回答，记下引用了哪几个课时；只发课件正文与问题，不发员工、会员数据';
COMMENT ON COLUMN academy_tutor_questions.sources IS '回答引用的课时：[{lessonId, title}]';
COMMENT ON COLUMN academy_tutor_questions.status IS 'answering 回答中 / done 答完 / failed 没答出来 / unconfigured 没配模型服务';
