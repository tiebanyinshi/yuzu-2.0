-- 汤崎学堂第一批（店主 2026-11-27，docs/ACADEMY.md 第 4、9 节，PENDING_DECISIONS XT01–XT12）：
--   · 课程（一门课 = 学习地图上的一个阶段）与课时（图文互动课件 / 员工培训里的文件 / 测验 / 实操签核）；
--   · 学习地图与它的阶段（课程按顺序）；指派规则（地图或课程 × 全员 / 部门 / 岗位 / 个人 × 必修或推荐 × 期限）；
--   · 每人每课时的进度与时长、每人每天的学习时长、谁学完了哪张地图、学分流水（只追加，同一件事只给一次）、课程评分；
--   · 新权限 academy.manage（学堂管理），建议权限给人力行政部负责人（总裁默认都有）。
-- 课程、地图来自内置课件包的记包的版本与内容摘要：管理员本地改过（local_edited）就不再用新版覆盖。
-- 后台新建的课程、课时、地图、指派都带操作编号（client_key）与原请求摘要（request_hash）：没收到结果原样重提返回原来那个，同一编号换了内容拒绝。
-- 回滚：docs/rollback/600_academy_core.down.sql。

CREATE TABLE academy_courses (
  id             bigserial PRIMARY KEY,
  code           text UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  summary        text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 300),
  category       text NOT NULL CHECK (category IN ('culture', 'must_know', 'industry', 'skill', 'system', 'safety', 'management')),
  department_key text REFERENCES org_departments (key),
  dept_only      boolean NOT NULL DEFAULT false,
  cover          text NOT NULL DEFAULT 'pine' CHECK (cover IN ('pine', 'lake', 'yuzu', 'ember', 'clay', 'moss')),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort           integer NOT NULL DEFAULT 100,
  pack_version   integer CHECK (pack_version >= 1),
  pack_hash      text CHECK (pack_hash ~ '^[0-9a-f]{64}$'),
  local_edited   boolean NOT NULL DEFAULT false,
  version        integer NOT NULL DEFAULT 1,
  client_key     uuid UNIQUE,
  request_hash   text CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by     bigint REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  CHECK (NOT dept_only OR department_key IS NOT NULL),
  CHECK ((client_key IS NULL) = (request_hash IS NULL))
);
CREATE INDEX academy_courses_department_idx ON academy_courses (department_key) WHERE department_key IS NOT NULL;
COMMENT ON TABLE academy_courses IS '学堂课程（docs/ACADEMY.md）：一门课 = 学习地图上的一个阶段；分类即知识中心的栏目；来自内置课件包的记包版本与内容摘要';
COMMENT ON COLUMN academy_courses.code IS '课程编号（内置课件包用它对上已导入的课程）；自己新建的为空';
COMMENT ON COLUMN academy_courses.category IS 'culture 汤崎之道 / must_know 应知应会 / industry 行业通识 / skill 岗位技能 / system 系统小课堂 / safety 安全 / management 管理';
COMMENT ON COLUMN academy_courses.department_key IS '属于哪个部门的知识中心；为空是全员通用';
COMMENT ON COLUMN academy_courses.dept_only IS '只本部门（与被指派的人）看得到（XT02）';
COMMENT ON COLUMN academy_courses.pack_hash IS '从内置课件包导入时内容的 SHA-256；包有新版且 local_edited = false 时才能直接更新';
COMMENT ON COLUMN academy_courses.local_edited IS '导入以后管理员改过（再导新版不覆盖）';
COMMENT ON COLUMN academy_courses.request_hash IS '新建时原请求的摘要：同一操作编号重提时内容不一样的拒绝（后台新建的都带编号；从内置课件包导入的两列都为空）';

CREATE TABLE academy_lessons (
  id         bigserial PRIMARY KEY,
  course_id  bigint NOT NULL REFERENCES academy_courses (id),
  pack_key   text CHECK (pack_key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  seq        integer NOT NULL DEFAULT 100,
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  kind       text NOT NULL CHECK (kind IN ('article', 'file', 'quiz', 'practical')),
  body       text NOT NULL DEFAULT '' CHECK (char_length(body) <= 60000),
  file_id    bigint REFERENCES training_files (id),
  quiz_count smallint CHECK (quiz_count BETWEEN 1 AND 50),
  quiz_pass  smallint CHECK (quiz_pass BETWEEN 1 AND 100),
  minutes    smallint NOT NULL DEFAULT 5 CHECK (minutes BETWEEN 1 AND 240),
  credits    smallint NOT NULL DEFAULT 1 CHECK (credits BETWEEN 0 AND 20),
  active     boolean NOT NULL DEFAULT true,
  version    integer NOT NULL DEFAULT 1,
  client_key uuid UNIQUE,
  request_hash text CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, pack_key),
  CHECK ((client_key IS NULL) = (request_hash IS NULL)),
  CHECK ((kind = 'file') = (file_id IS NOT NULL)),
  CHECK ((kind = 'quiz') = (quiz_count IS NOT NULL AND quiz_pass IS NOT NULL))
);
CREATE INDEX academy_lessons_course_idx ON academy_lessons (course_id, seq, id);
CREATE INDEX academy_lessons_file_idx ON academy_lessons (file_id) WHERE file_id IS NOT NULL;
COMMENT ON TABLE academy_lessons IS '学堂课时（学习任务）：article 图文互动课件（body 是课件文本）/ file 员工培训的文件 / quiz 测验 / practical 实操签核（body 每行一个检查项）';
COMMENT ON COLUMN academy_lessons.pack_key IS '内置课件包里的课时编号（同一门课里唯一）；自己加的为空';
COMMENT ON COLUMN academy_lessons.body IS 'article：学堂课件文本（扩展 Markdown，src/shared/academy-markup.ts）；practical：每行一个检查项';
COMMENT ON COLUMN academy_lessons.quiz_count IS '测验每次抽几道题';
COMMENT ON COLUMN academy_lessons.quiz_pass IS '测验及格线（百分制）';
COMMENT ON COLUMN academy_lessons.minutes IS '预计学习时长（分钟）';
COMMENT ON COLUMN academy_lessons.credits IS '完成这一课时给的学分（第一次完成才给）';
COMMENT ON COLUMN academy_lessons.active IS '下架的课时不算进课程完成';

CREATE TABLE academy_paths (
  id           bigserial PRIMARY KEY,
  code         text UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 40),
  summary      text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 300),
  cover        text NOT NULL DEFAULT 'pine' CHECK (cover IN ('pine', 'lake', 'yuzu', 'ember', 'clay', 'moss')),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort         integer NOT NULL DEFAULT 100,
  credits      smallint NOT NULL DEFAULT 5 CHECK (credits BETWEEN 0 AND 50),
  valid_months smallint CHECK (valid_months BETWEEN 1 AND 60),
  pack_version integer CHECK (pack_version >= 1),
  pack_hash    text CHECK (pack_hash ~ '^[0-9a-f]{64}$'),
  local_edited boolean NOT NULL DEFAULT false,
  version      integer NOT NULL DEFAULT 1,
  client_key   uuid UNIQUE,
  request_hash text CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by   bigint REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK ((client_key IS NULL) = (request_hash IS NULL))
);
COMMENT ON TABLE academy_paths IS '学习地图（docs/ACADEMY.md 第 4 节）：按岗位或计划排好顺序的一串课程，全部完成发证书';
COMMENT ON COLUMN academy_paths.credits IS '完成整张地图另给的学分';
COMMENT ON COLUMN academy_paths.valid_months IS '证书有效几个月（安全类默认 12）；为空是长期有效';

CREATE TABLE academy_path_courses (
  path_id   bigint NOT NULL REFERENCES academy_paths (id),
  course_id bigint NOT NULL REFERENCES academy_courses (id),
  seq       integer NOT NULL CHECK (seq >= 1),
  PRIMARY KEY (path_id, course_id)
);
CREATE INDEX academy_path_courses_course_idx ON academy_path_courses (course_id);
COMMENT ON TABLE academy_path_courses IS '学习地图的阶段：一个阶段一门课，按 seq 排';

CREATE TABLE academy_path_completions (
  staff_id     bigint NOT NULL REFERENCES staff (id),
  path_id      bigint NOT NULL REFERENCES academy_paths (id),
  completed_on date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, path_id)
);
CREATE INDEX academy_path_completions_path_idx ON academy_path_completions (path_id);
CREATE TRIGGER academy_path_completions_append_only BEFORE UPDATE OR DELETE ON academy_path_completions
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
COMMENT ON TABLE academy_path_completions IS '谁学完了哪张学习地图（只追加）：记下的那一刻给地图学分（以后还发证书）；地图后来才上架、加了已学完的课，也在上架时补记';
COMMENT ON COLUMN academy_path_completions.completed_on IS '学完的营业日';

CREATE TABLE academy_assignments (
  id             bigserial PRIMARY KEY,
  path_id        bigint REFERENCES academy_paths (id),
  course_id      bigint REFERENCES academy_courses (id),
  audience       text NOT NULL CHECK (audience IN ('all', 'department', 'position', 'staff')),
  department_key text REFERENCES org_departments (key),
  position_key   text REFERENCES position_catalog (key),
  staff_id       bigint REFERENCES staff (id),
  required       boolean NOT NULL DEFAULT true,
  due_days       smallint CHECK (due_days BETWEEN 1 AND 365),
  starts_on      date NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  version        integer NOT NULL DEFAULT 1,
  client_key     uuid UNIQUE,
  request_hash   text CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by     bigint REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(path_id, course_id) = 1),
  CHECK ((client_key IS NULL) = (request_hash IS NULL)),
  CHECK ((audience = 'department') = (department_key IS NOT NULL)),
  CHECK ((audience = 'position') = (position_key IS NOT NULL)),
  CHECK ((audience = 'staff') = (staff_id IS NOT NULL))
);
CREATE INDEX academy_assignments_path_idx ON academy_assignments (path_id) WHERE path_id IS NOT NULL;
CREATE INDEX academy_assignments_course_idx ON academy_assignments (course_id) WHERE course_id IS NOT NULL;
CREATE INDEX academy_assignments_department_idx ON academy_assignments (department_key) WHERE department_key IS NOT NULL;
CREATE INDEX academy_assignments_position_idx ON academy_assignments (position_key) WHERE position_key IS NOT NULL;
COMMENT ON TABLE academy_assignments IS '学堂指派规则：一张地图或一门课 × 对象（全员 / 部门 / 岗位 / 个人）；员工命中的规则合起来是「我的必修 / 推荐」，新员工、调岗自动带上';
COMMENT ON COLUMN academy_assignments.required IS 'true 必修 / false 推荐（选修）';
COMMENT ON COLUMN academy_assignments.due_days IS '几天内完成：截止日 = max(starts_on, 入职日) + due_days；为空不设截止';
COMMENT ON COLUMN academy_assignments.starts_on IS '指派生效日（营业日）';

CREATE TABLE academy_progress (
  staff_id     bigint NOT NULL REFERENCES staff (id),
  lesson_id    bigint NOT NULL REFERENCES academy_lessons (id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  seconds      integer NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  last_ping_at timestamptz,
  PRIMARY KEY (staff_id, lesson_id)
);
CREATE INDEX academy_progress_lesson_idx ON academy_progress (lesson_id);
COMMENT ON TABLE academy_progress IS '每人每课时的学习进度：第一次打开、完成时刻、累计学习时长';
COMMENT ON COLUMN academy_progress.seconds IS '累计学习时长（秒）：页面在前台才计，服务端按两次上报的间隔封顶';
COMMENT ON COLUMN academy_progress.last_ping_at IS '上一次上报时长的时刻（下一次最多只认这段间隔）';

CREATE TABLE academy_study_days (
  staff_id bigint NOT NULL REFERENCES staff (id),
  day      date NOT NULL,
  seconds  integer NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  PRIMARY KEY (staff_id, day)
);
CREATE INDEX academy_study_days_day_idx ON academy_study_days (day);
COMMENT ON TABLE academy_study_days IS '每人每天的学习时长（时长榜按月汇总）';
COMMENT ON COLUMN academy_study_days.seconds IS '这一天的学习时长（秒）';

CREATE TABLE academy_credits (
  id         bigserial PRIMARY KEY,
  staff_id   bigint NOT NULL REFERENCES staff (id),
  points     integer NOT NULL CHECK (points BETWEEN 1 AND 100),
  reason     text NOT NULL CHECK (reason IN ('lesson', 'daily', 'path')),
  ref_no     bigint NOT NULL,
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, reason, ref_no)
);
CREATE INDEX academy_credits_created_idx ON academy_credits (created_at);
CREATE TRIGGER academy_credits_append_only BEFORE UPDATE OR DELETE ON academy_credits
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
COMMENT ON TABLE academy_credits IS '学分流水（只追加）：同一人同一件事只给一次（XT04）';
COMMENT ON COLUMN academy_credits.points IS '学分';
COMMENT ON COLUMN academy_credits.reason IS 'lesson 完成课时（含测验及格、实操通过）/ daily 每日一练 / path 完成学习地图';
COMMENT ON COLUMN academy_credits.ref_no IS 'lesson：课时编号；path：地图编号；daily：营业日 yyyymmdd';

CREATE TABLE academy_feedback (
  staff_id   bigint NOT NULL REFERENCES staff (id),
  course_id  bigint NOT NULL REFERENCES academy_courses (id),
  rating     smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, course_id)
);
CREATE INDEX academy_feedback_course_idx ON academy_feedback (course_id);
COMMENT ON TABLE academy_feedback IS '课程评分（柯氏一级评估：学完的人打 1–5 星、写一句话）';

INSERT INTO position_suggestions (position_key, permission) VALUES ('hr.lead', 'academy.manage') ON CONFLICT DO NOTHING;
