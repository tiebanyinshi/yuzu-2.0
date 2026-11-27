// 汤崎学堂（店主 2026-11-27，docs/ACADEMY.md、PENDING_DECISIONS XT01–XT12）：课程、课时、学习地图、指派、进度、学分、等级与榜单。

export const ACADEMY_CATEGORIES = ['culture', 'must_know', 'industry', 'skill', 'system', 'safety', 'management'] as const;
export type AcademyCategory = (typeof ACADEMY_CATEGORIES)[number];
/** 分类 = 知识中心的栏目 */
export const ACADEMY_CATEGORY_LABELS: Record<AcademyCategory, string> = {
  culture: '汤崎之道',
  must_know: '应知应会',
  industry: '行业通识',
  skill: '岗位技能',
  system: '系统小课堂',
  safety: '安全',
  management: '管理',
};

/** 封面色（取样式表里已有的几种颜色） */
export const ACADEMY_COVERS = ['pine', 'lake', 'yuzu', 'ember', 'clay', 'moss'] as const;
export type AcademyCover = (typeof ACADEMY_COVERS)[number];

export type AcademyStatus = 'draft' | 'published' | 'archived';
export const ACADEMY_STATUS_LABELS: Record<AcademyStatus, string> = { draft: '草稿', published: '已上架', archived: '已下架' };

export const ACADEMY_LESSON_KINDS = ['article', 'file', 'quiz', 'practical'] as const;
export type AcademyLessonKind = (typeof ACADEMY_LESSON_KINDS)[number];
export const ACADEMY_LESSON_KIND_LABELS: Record<AcademyLessonKind, string> = { article: '图文课件', file: '视频 / 文件', quiz: '测验', practical: '实操签核' };
/** 各类课时默认给的学分（XT04；课时上可改） */
export const ACADEMY_DEFAULT_CREDITS: Record<AcademyLessonKind, number> = { article: 1, file: 1, quiz: 2, practical: 3 };
/** 完成一张学习地图默认另给的学分、每日一练每天的学分（XT04） */
export const ACADEMY_PATH_CREDITS = 5;
/** 测验默认每次几道题、及格线（XT03） */
export const ACADEMY_QUIZ_DEFAULT = { count: 5, pass: 80 } as const;

/** 我对一个课时：没开始 / 学过还没完成 / 完成 */
export type AcademyLessonState = 'todo' | 'started' | 'done';

export interface AcademyLessonSummary {
  id: number;
  courseId: number;
  seq: number;
  title: string;
  kind: AcademyLessonKind;
  minutes: number;
  credits: number;
  active: boolean;
  state: AcademyLessonState;
  /** 测验：每次几题、及格线 */
  quiz: { count: number; pass: number } | null;
  /** 文件课时：员工培训里的哪份文件 */
  fileId: number | null;
}

export interface AcademyCourseSummary {
  id: number;
  code: string | null;
  title: string;
  summary: string;
  category: AcademyCategory;
  departmentKey: string | null;
  deptOnly: boolean;
  cover: AcademyCover;
  status: AcademyStatus;
  sort: number;
  /** 上架的课时数、我完成的数 */
  lessonCount: number;
  doneCount: number;
  minutes: number;
  credits: number;
  rating: { avg: number; count: number } | null;
  version: number;
}

export interface AcademyCourseDetail extends AcademyCourseSummary {
  lessons: AcademyLessonSummary[];
  myFeedback: { rating: number; comment: string } | null;
  /** 这门课在哪几张上架的学习地图里 */
  paths: { id: number; title: string }[];
}

/** 打开一个课时：课件文本、文件，以及前一节、后一节 */
export interface AcademyLessonView {
  lesson: AcademyLessonSummary & { body: string };
  course: { id: number; title: string; category: AcademyCategory };
  prevId: number | null;
  nextId: number | null;
  /** 我在这一课时上累计学了多少秒 */
  seconds: number;
  /** 文件课时：员工培训里的哪份文件（页面按员工培训的接口读内容；建议放在全员看得到的「培训资料」里） */
  file: { id: number; folderId: number; title: string } | null;
}

export interface AcademyPathSummary {
  id: number;
  code: string | null;
  title: string;
  summary: string;
  cover: AcademyCover;
  status: AcademyStatus;
  sort: number;
  credits: number;
  validMonths: number | null;
  /** 阶段（课程）数、我完成的数 */
  courseCount: number;
  doneCount: number;
  version: number;
}

export interface AcademyPathDetail extends AcademyPathSummary {
  stages: AcademyCourseSummary[];
}

/** 我被指派的一项（地图或课程）：必修 / 推荐、截止、进度 */
export interface AcademyAssigned {
  kind: 'path' | 'course';
  id: number;
  title: string;
  cover: AcademyCover;
  required: boolean;
  /** 截止日（营业日）；没设期限为空 */
  dueOn: string | null;
  overdue: boolean;
  done: number;
  total: number;
  completed: boolean;
}

export interface AcademyLevel {
  level: number;
  title: string;
  min: number;
}

/** 汤主题的六级（XT05）：学分到了门槛就升级 */
export const ACADEMY_LEVELS: readonly AcademyLevel[] = [
  { level: 1, title: '初试水温', min: 0 },
  { level: 2, title: '温汤渐暖', min: 60 },
  { level: 3, title: '汤中好手', min: 150 },
  { level: 4, title: '独当一面', min: 300 },
  { level: 5, title: '汤崎匠人', min: 500 },
  { level: 6, title: '一代宗师', min: 800 },
];

/** 学分 → 当前等级与下一级（满级时下一级为空） */
export function academyLevelOf(credits: number): { current: AcademyLevel; next: AcademyLevel | null } {
  let i = 0;
  while (i + 1 < ACADEMY_LEVELS.length && credits >= ACADEMY_LEVELS[i + 1]!.min) i += 1;
  return { current: ACADEMY_LEVELS[i]!, next: ACADEMY_LEVELS[i + 1] ?? null };
}

/** 截止日 = max(指派生效日, 入职日) + 天数（XT 第 4 节）；没设天数为空 */
export function academyDueOn(startsOn: string, hireDate: string | null, dueDays: number | null): string | null {
  if (!dueDays) return null;
  const from = hireDate && hireDate > startsOn ? hireDate : startsOn;
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dueDays);
  return d.toISOString().slice(0, 10);
}

export interface AcademyMe {
  staffId: number;
  name: string;
  storeName: string | null;
  departmentName: string | null;
  positionTitle: string | null;
  credits: number;
  level: AcademyLevel;
  nextLevel: AcademyLevel | null;
  /** 累计学习时长、本月学习时长（秒） */
  seconds: number;
  monthSeconds: number;
  completedLessons: number;
}

export type AcademyRankBoard = 'credits' | 'minutes';
export type AcademyRankPeriod = 'month' | 'all';
export type AcademyRankScope = 'company' | 'store';

export interface AcademyRankRow {
  rank: number;
  staffId: number;
  name: string;
  storeName: string | null;
  departmentName: string | null;
  /** 学分榜是学分；时长榜是分钟 */
  value: number;
}

export interface AcademyRank {
  board: AcademyRankBoard;
  period: AcademyRankPeriod;
  scope: AcademyRankScope;
  rows: AcademyRankRow[];
  me: AcademyRankRow | null;
}

/** 学堂首页（docs/ACADEMY.md 第 8 节） */
export interface AcademyHome {
  me: AcademyMe;
  required: AcademyAssigned[];
  recommended: AcademyAssigned[];
  /** 继续学：最近学过、还没完成的课时 */
  resume: { lessonId: number; lessonTitle: string; courseId: number; courseTitle: string } | null;
  paths: AcademyPathSummary[];
  /** 知识中心：每个分类上架的课程数 */
  categories: { category: AcademyCategory; count: number }[];
  canManage: boolean;
}

/** 完成一个课时以后：这次给了几分、这门课 / 哪张地图因此完成了 */
export interface AcademyCompletion {
  lessonId: number;
  credits: number;
  courseCompleted: boolean;
  pathsCompleted: { id: number; title: string; credits: number }[];
  /** 升级了（新等级） */
  levelUp: AcademyLevel | null;
}

/** 管理端的学习数据：一条指派完成得怎么样 */
export interface AcademyAssignmentStat {
  id: number;
  targetKind: 'path' | 'course';
  targetId: number;
  targetTitle: string;
  audience: 'all' | 'department' | 'position' | 'staff';
  audienceLabel: string;
  required: boolean;
  dueDays: number | null;
  startsOn: string;
  active: boolean;
  version: number;
  /** 命中的在职员工数、已完成、已逾期 */
  people: number;
  completed: number;
  overdue: number;
}

/** 管理端：一个课时连同课件文本与版本 */
export interface AcademyAdminLesson extends AcademyLessonSummary {
  body: string;
  version: number;
  packKey: string | null;
}

/** 管理端：一门课（含草稿、下架）与它全部的课时 */
export interface AcademyAdminCourse {
  course: AcademyCourseSummary & { packVersion: number | null; localEdited: boolean };
  lessons: AcademyAdminLesson[];
}

/** 管理端：一张地图与它的阶段（课程编号，按顺序） */
export interface AcademyAdminPath extends AcademyPathSummary {
  courseIds: number[];
  packVersion: number | null;
  localEdited: boolean;
}

/** 管理端：一条指派命中的一个人完成得怎么样 */
export interface AcademyPersonProgress {
  staffId: number;
  name: string;
  departmentName: string | null;
  dueOn: string | null;
  done: number;
  total: number;
  completed: boolean;
  overdue: boolean;
}

/** 管理端：员工的学习概况 */
export interface AcademyLearnerRow {
  staffId: number;
  name: string;
  departmentName: string | null;
  credits: number;
  minutes: number;
  completedLessons: number;
  lastStudyOn: string | null;
}
