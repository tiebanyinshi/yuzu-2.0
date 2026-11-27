-- 汤崎学堂第二批：测评（店主 2026-11-27，docs/ACADEMY.md 第 5、7、9 节，PENDING_DECISIONS XT03、XT07–XT09）：
--   · 题库：题挂在课上（测验从这门课的题里抽）；来源（手写 / 课件包 / AI / 表格导入）、状态（草稿 / 启用 / 停用）；
--   · 测验：抽到的题当场存快照，交卷后不能改（之后改题不影响已交的卷）；
--   · 每日一练：每人每题一张卡（FSRS：稳定度、难度、下次复习日），作答流水只追加；
--   · 掌握度：每人每个知识点一个概率（BKT）；
--   · 实操签核（只追加）：带教逐项打勾、签「通过 / 再练」，不能给自己签；
--   · 证书：完成学习地图自动发，可设有效期，管理员可以撤销并写原因；
--   · 新权限 academy.coach（带教签核），建议权限给总经办与各部门负责人（与「本部门排班与考勤」同一批）。
-- 回滚：docs/rollback/641_academy_assess.down.sql。

CREATE TABLE academy_questions (
  id          bigserial PRIMARY KEY,
  course_id   bigint NOT NULL REFERENCES academy_courses (id),
  pack_key    text UNIQUE CHECK (pack_key ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  skill       text NOT NULL CHECK (char_length(skill) BETWEEN 1 AND 30),
  kind        text NOT NULL CHECK (kind IN ('single', 'multi', 'judge', 'recall')),
  level       smallint NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  stem        text NOT NULL CHECK (char_length(stem) BETWEEN 1 AND 300),
  options     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
  answer      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(answer) = 'array'),
  answer_text text NOT NULL DEFAULT '' CHECK (char_length(answer_text) <= 500),
  explanation text NOT NULL DEFAULT '' CHECK (char_length(explanation) <= 500),
  source      text NOT NULL CHECK (source IN ('manual', 'pack', 'ai', 'import')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'retired')),
  version     integer NOT NULL DEFAULT 1,
  client_key  uuid UNIQUE,
  request_hash text CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by  bigint REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'recall') = (jsonb_array_length(options) = 0)),
  CHECK ((client_key IS NULL) = (request_hash IS NULL))
);
CREATE INDEX academy_questions_course_idx ON academy_questions (course_id, status);
COMMENT ON TABLE academy_questions IS '学堂题库：题挂在课上（测验从这门课启用的题里抽，问答卡只进每日一练）；AI 出的题先是草稿，人审过才启用';
COMMENT ON COLUMN academy_questions.pack_key IS '内置课件包里的题号（课程编号-序号），导入时用它对上已导入的题';
COMMENT ON COLUMN academy_questions.skill IS '知识点（掌握度按它算）';
COMMENT ON COLUMN academy_questions.kind IS 'single 单选 / multi 多选 / judge 判断 / recall 问答卡（自己评记没记住）';
COMMENT ON COLUMN academy_questions.level IS '难度：1 记住、2 理解、3 应用（布鲁姆分类三档）';
COMMENT ON COLUMN academy_questions.answer IS '对的选项（从 0 起的下标数组）';
COMMENT ON COLUMN academy_questions.answer_text IS '问答卡的答案';
COMMENT ON COLUMN academy_questions.request_hash IS '后台新建时原请求的摘要：同一操作编号重提时内容不一样的拒绝（课件包导入、AI 出题的两列为空）';

CREATE TABLE academy_attempts (
  id           bigserial PRIMARY KEY,
  staff_id     bigint NOT NULL REFERENCES staff (id),
  lesson_id    bigint NOT NULL REFERENCES academy_lessons (id),
  client_key   uuid NOT NULL UNIQUE,
  questions    jsonb NOT NULL CHECK (jsonb_typeof(questions) = 'array'),
  pass_pct     smallint NOT NULL CHECK (pass_pct BETWEEN 1 AND 100),
  total        smallint NOT NULL CHECK (total BETWEEN 1 AND 50),
  answers      jsonb,
  correct      smallint CHECK (correct >= 0),
  score        smallint CHECK (score BETWEEN 0 AND 100),
  passed       boolean,
  started_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  CHECK ((submitted_at IS NULL) = (answers IS NULL) AND (submitted_at IS NULL) = (score IS NULL) AND (submitted_at IS NULL) = (passed IS NULL))
);
CREATE INDEX academy_attempts_staff_idx ON academy_attempts (staff_id, lesson_id);
CREATE INDEX academy_attempts_lesson_idx ON academy_attempts (lesson_id);
COMMENT ON TABLE academy_attempts IS '学堂测验的一次作答：抽到的题当场存快照（题干、选项、答案），交卷后整行不能再改';
COMMENT ON COLUMN academy_attempts.questions IS '抽到的题的快照：[{id, kind, skill, stem, options, answer, explanation}]';
COMMENT ON COLUMN academy_attempts.pass_pct IS '这次的及格线（百分制，开卷时取课时的设置）';
COMMENT ON COLUMN academy_attempts.answers IS '交卷时的作答（每题一个选项下标数组）';
COMMENT ON COLUMN academy_attempts.score IS '得分（百分制，答对题数 / 总题数）';

CREATE FUNCTION academy_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '学堂测验记录不能删除'; END IF;
  IF OLD.submitted_at IS NOT NULL THEN RAISE EXCEPTION '已交卷的测验不能再改'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER academy_attempts_guard BEFORE UPDATE OR DELETE ON academy_attempts FOR EACH ROW EXECUTE FUNCTION academy_attempt_guard();

CREATE TABLE academy_cards (
  staff_id       bigint NOT NULL REFERENCES staff (id),
  question_id    bigint NOT NULL REFERENCES academy_questions (id),
  stability      double precision NOT NULL CHECK (stability > 0),
  difficulty     double precision NOT NULL CHECK (difficulty BETWEEN 1 AND 10),
  due_on         date NOT NULL,
  reps           integer NOT NULL DEFAULT 0 CHECK (reps >= 0),
  lapses         integer NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  last_review_on date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, question_id)
);
CREATE INDEX academy_cards_question_idx ON academy_cards (question_id);
CREATE INDEX academy_cards_due_idx ON academy_cards (staff_id, due_on);
COMMENT ON TABLE academy_cards IS '每日一练的记忆卡（FSRS 间隔复习）：每人每题一张；没有卡的题是「新题」';
COMMENT ON COLUMN academy_cards.stability IS '记忆稳定度（天）：可提取概率降到 0.9 要多少天';
COMMENT ON COLUMN academy_cards.difficulty IS '难度（1–10）';
COMMENT ON COLUMN academy_cards.due_on IS '下次该复习的营业日';
COMMENT ON COLUMN academy_cards.lapses IS '忘了（评 1）的次数';
COMMENT ON COLUMN academy_cards.last_review_on IS '上一次复习的营业日（算间隔天数）';

CREATE TABLE academy_reviews (
  id           bigserial PRIMARY KEY,
  staff_id     bigint NOT NULL REFERENCES staff (id),
  question_id  bigint NOT NULL REFERENCES academy_questions (id),
  client_key   uuid UNIQUE,
  source       text NOT NULL CHECK (source IN ('daily', 'quiz')),
  grade        smallint NOT NULL CHECK (grade BETWEEN 1 AND 4),
  correct      boolean,
  was_new      boolean NOT NULL,
  elapsed_days double precision NOT NULL CHECK (elapsed_days >= 0),
  stability    double precision NOT NULL,
  difficulty   double precision NOT NULL,
  due_on       date NOT NULL,
  reviewed_on  date NOT NULL,
  reviewed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX academy_reviews_staff_idx ON academy_reviews (staff_id, reviewed_on);
CREATE INDEX academy_reviews_question_idx ON academy_reviews (question_id);
CREATE TRIGGER academy_reviews_append_only BEFORE UPDATE OR DELETE ON academy_reviews
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
COMMENT ON TABLE academy_reviews IS '每日一练与测验的作答流水（只追加）：评分、答对没有、这次之后的稳定度、难度、下次复习日';
COMMENT ON COLUMN academy_reviews.grade IS '1 忘了 / 2 模糊 / 3 记得 / 4 很熟（客观题：答错 1、答对 3）';
COMMENT ON COLUMN academy_reviews.correct IS '客观题答对没有；问答卡为空（自己评）';
COMMENT ON COLUMN academy_reviews.was_new IS '这道题第一次练（新题每天有上限）';
COMMENT ON COLUMN academy_reviews.elapsed_days IS '距上一次复习过了几天';
COMMENT ON COLUMN academy_reviews.reviewed_on IS '营业日';

CREATE TABLE academy_mastery (
  staff_id   bigint NOT NULL REFERENCES staff (id),
  skill      text NOT NULL CHECK (char_length(skill) BETWEEN 1 AND 30),
  p_known    double precision NOT NULL CHECK (p_known BETWEEN 0 AND 1),
  attempts   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  correct    integer NOT NULL DEFAULT 0 CHECK (correct >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, skill)
);
COMMENT ON TABLE academy_mastery IS '知识点掌握度（贝叶斯知识追踪 BKT）：每次作答更新；≥ 0.95 已掌握、< 0.6 薄弱';
COMMENT ON COLUMN academy_mastery.p_known IS '掌握了的概率（0–1）';

CREATE TABLE academy_signoffs (
  id         bigserial PRIMARY KEY,
  staff_id   bigint NOT NULL REFERENCES staff (id),
  lesson_id  bigint NOT NULL REFERENCES academy_lessons (id),
  result     text NOT NULL CHECK (result IN ('pass', 'retry')),
  checks     jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'),
  comment    text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 300),
  signed_by  bigint NOT NULL REFERENCES staff (id),
  client_key uuid NOT NULL UNIQUE,
  signed_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (signed_by <> staff_id)
);
CREATE INDEX academy_signoffs_staff_idx ON academy_signoffs (staff_id, lesson_id);
CREATE INDEX academy_signoffs_lesson_idx ON academy_signoffs (lesson_id);
CREATE TRIGGER academy_signoffs_append_only BEFORE UPDATE OR DELETE ON academy_signoffs
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
COMMENT ON TABLE academy_signoffs IS '实操签核（柯氏三级评估，只追加）：带教在岗看过，逐项打勾，签「通过」或「再练」；不能给自己签';
COMMENT ON COLUMN academy_signoffs.staff_id IS '被考核的员工';
COMMENT ON COLUMN academy_signoffs.checks IS '每个检查项是否达标（与课时检查项一一对应）';

CREATE TABLE academy_certificates (
  id            bigserial PRIMARY KEY,
  cert_no       text NOT NULL UNIQUE,
  staff_id      bigint NOT NULL REFERENCES staff (id),
  path_id       bigint NOT NULL REFERENCES academy_paths (id),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  issued_on     date NOT NULL,
  expires_on    date,
  revoked_at    timestamptz,
  revoked_by    bigint REFERENCES staff (id),
  revoke_reason text CHECK (char_length(revoke_reason) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE UNIQUE INDEX academy_certificates_live_uq ON academy_certificates (staff_id, path_id) WHERE revoked_at IS NULL;
CREATE INDEX academy_certificates_path_idx ON academy_certificates (path_id);
COMMENT ON TABLE academy_certificates IS '学堂证书：完成一张学习地图自动发；有效期按地图（为空长期有效）；撤销记人与原因，同一人同一张地图只有一张没撤销的';
COMMENT ON COLUMN academy_certificates.cert_no IS '证书编号（XT + 颁发日 + 当天序号）';
COMMENT ON COLUMN academy_certificates.expires_on IS '到期日；为空长期有效';

INSERT INTO position_suggestions (position_key, permission)
SELECT k, 'academy.coach'
FROM unnest(ARRAY['gmo', 'hr.lead', 'front.lead', 'male.lead', 'female.lead', 'ent.lead', 'dining.lead', 'kangmei.lead', 'kitchen.lead',
                  'wellness.lead', 'eng.lead', 'finance.lead', 'outreach.lead', 'vip.lead']) AS k
ON CONFLICT DO NOTHING;
