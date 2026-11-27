// 技师名册导入（8.1.35 福田迁移第二批，docs/FUTIAN_MIGRATION.md 第 2.4 节）：直接认旧收银系统的「技师导入模板」——
// 表头在哪一行都行（前面的「填写须知」跳过），认这几列：技师号、姓名、性别、技师等级、技师组别、昵称、入职日期（其余列不导）。
//   · 技师号 1–6 位字母数字（本店唯一）；姓名 1–16 字；性别 男 / 女（必填，没写的报出来）；
//   · 等级 标准 / 专业 / 优选（与价格档一致），没写的按「标准」；
//   · 组别 ≤16 字，没有的组导入时建；入职日期认「2023-02-08」「2023/2/8」与 Excel 的日期。
// 8.2.2（《技师排班系统需求沟通会》五.2，docs/V8222_TECHNICIANS.md 第 8 节）：后台网页也能导（technician-import-web.ts），多认四列——
//   电话（手机、手机号、联系电话）11 位手机号；身高（厘米，写 1.65 的按米）；体重（公斤，写「斤」的折半）；星级（1–10，写「3 星」「三星」「★★★」都认）。
//   这几列格子空着是「不改」（已有的技师不动这一项，新建的为空）。网页导入时性别可以不写（genderOptional：新建的再要），已有的技师不改性别。

import type { PriceTier } from './catalog';

export interface TechnicianImportRow {
  /** 表格里的行号（从 1 起） */
  line: number;
  techNo: string;
  name: string;
  gender: 'male' | 'female';
  grade: PriceTier;
  group: string | null;
  nickname: string;
  hiredOn: string | null;
  /** 8.2.2：空着的为 null（不改） */
  phone: string | null;
  heightCm: number | null;
  weightKg: number | null;
  star: number | null;
}

/** 网页导入（8.2.2）：性别可以不写，解析出来是 null，新建时再要 */
export type TechnicianImportRowLoose = Omit<TechnicianImportRow, 'gender'> & { gender: 'male' | 'female' | null };

export interface TechnicianImportParse {
  rows: TechnicianImportRow[];
  errors: { line: number; message: string }[];
}

export const TECHNICIAN_IMPORT_MAX_ROWS = 1000;

const COLUMNS: Record<string, string[]> = {
  techNo: ['技师号', '工号', 'tech_no', 'techno'],
  name: ['姓名', 'name'],
  gender: ['性别', 'gender'],
  grade: ['技师等级', '等级', 'grade'],
  group: ['技师组别', '组别', '分组', 'group'],
  nickname: ['昵称', '花名', 'nickname'],
  hiredOn: ['入职日期', 'hired_on'],
  phone: ['电话', '手机', '手机号', '联系电话', '联系方式', 'phone', 'mobile'],
  height: ['身高', 'height'],
  weight: ['体重', 'weight'],
  star: ['星级', '技师星级', 'star'],
};

/** 模板下载与页面上的「认得的表头」用 */
export const TECHNICIAN_IMPORT_HEADERS = ['工号', '姓名', '花名', '性别', '电话', '组别', '身高（厘米）', '体重（公斤）', '星级', '技师等级', '入职日期'] as const;
export const technicianImportAliases = (): Record<string, string[]> => ({ ...COLUMNS });

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 手机：去掉空格、横线，11 位 1 开头；空为 null；认不出来为 undefined */
export function parsePhone(raw: string): string | null | undefined {
  const s = raw.replace(/[\s-]/g, '');
  if (!s) return null;
  return /^1\d{10}$/.test(s) ? s : undefined;
}

/** 身高：165、165cm、1.65、1.65m → 厘米；空为 null；超出 100–230 或认不出来为 undefined */
export function parseHeight(raw: string): number | null | undefined {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)(cm|厘米|m|米)?$/.exec(s);
  if (!m) return undefined;
  let v = Number(m[1]);
  if (m[2] === 'm' || m[2] === '米' || (!m[2] && v < 3)) v *= 100;
  const cm = Math.round(v);
  return cm >= 100 && cm <= 230 ? cm : undefined;
}

/** 体重：50、50kg、50公斤、100斤 → 公斤（取整）；空为 null；超出 30–200 或认不出来为 undefined */
export function parseWeight(raw: string): number | null | undefined {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)(kg|公斤|千克|斤)?$/.exec(s);
  if (!m) return undefined;
  const kg = Math.round(m[2] === '斤' ? Number(m[1]) / 2 : Number(m[1]));
  return kg >= 30 && kg <= 200 ? kg : undefined;
}

/** 星级：3、3星、三星、★★★ → 1–10；空为 null；认不出来为 undefined */
export function parseStar(raw: string): number | null | undefined {
  const s = raw.trim().replace(/\s+/g, '');
  if (!s) return null;
  let n: number | undefined;
  if (/^[★☆]+$/.test(s)) n = [...s].filter((c) => c === '★').length;
  else {
    const m = /^(\d+(?:\.0+)?|[一二两三四五六七八九十])(星|星级)?$/.exec(s);
    if (m) n = /^\d/.test(m[1]!) ? Math.floor(Number(m[1])) : CN_NUM[m[1]!];
  }
  return n !== undefined && n >= 1 && n <= 10 ? n : undefined;
}
const GENDERS: Record<string, 'male' | 'female'> = { 男: 'male', 女: 'female', male: 'male', female: 'female', 男宾: 'male', 女宾: 'female' };
const GRADES: Record<string, PriceTier> = { 标准: 'standard', 专业: 'professional', 优选: 'premium', standard: 'standard', professional: 'professional', premium: 'premium' };

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** Excel 日期序号（1900 日期系统）或文字日期 → YYYY-MM-DD；认不出来为 undefined，空为 null */
export function legacyDate(raw: string): string | null | undefined {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
    return dt.toISOString().slice(0, 10);
  }
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial < 20000 || serial > 80000) return undefined;
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  return undefined;
}

/** 「一星=标准,五星=专业」→ 等级对照（旧系统的星级，店主定） */
export function parseGradeMap(text: string): Record<string, PriceTier> | string {
  const out: Record<string, PriceTier> = {};
  for (const part of text
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const [from, to] = part.split('=').map((x) => x.trim());
    const tier = to ? GRADES[norm(to)] : undefined;
    if (!from || !tier) return `等级对照「${part}」看不懂，应写成「一星=标准」`;
    out[norm(from)] = tier;
  }
  return out;
}

/** 表格（每行一组单元格文字）→ 技师行；行号按表格里的位置；gradeMap 认旧系统的星级 */
export function parseTechnicianTable(table: string[][], opts: { gradeMap?: Record<string, PriceTier> } = {}): TechnicianImportParse {
  return parseTable(table, opts) as TechnicianImportParse;
}

/** 网页导入（8.2.2）：性别可以不写（新建的再要） */
export function parseTechnicianTableLoose(table: string[][], opts: { gradeMap?: Record<string, PriceTier> } = {}): { rows: TechnicianImportRowLoose[]; errors: TechnicianImportParse['errors'] } {
  return parseTable(table, { ...opts, genderOptional: true });
}

function parseTable(table: string[][], opts: { gradeMap?: Record<string, PriceTier>; genderOptional?: boolean }): { rows: TechnicianImportRowLoose[]; errors: TechnicianImportParse['errors'] } {
  const errors: TechnicianImportParse['errors'] = [];
  const rows: TechnicianImportRowLoose[] = [];
  const headerAt = table.findIndex((r) => r.some((c) => COLUMNS.techNo!.includes(norm(c))));
  if (headerAt < 0) return { rows, errors: [{ line: 1, message: '找不到表头（要有「技师号」「姓名」「性别」列）' }] };
  const header = table[headerAt]!.map(norm);
  const col: Record<string, number> = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    const i = header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
    if (i >= 0) col[key] = i;
  }
  for (const need of opts.genderOptional ? (['techNo', 'name'] as const) : (['techNo', 'name', 'gender'] as const)) {
    if (col[need] === undefined) errors.push({ line: headerAt + 1, message: `表头缺少「${COLUMNS[need]![0]}」列` });
  }
  if (errors.length) return { rows, errors };
  const at = (r: string[], key: string) => (col[key] === undefined ? '' : (r[col[key]!] ?? '').trim());
  const seen = new Map<string, number>();
  for (let i = headerAt + 1; i < table.length; i += 1) {
    const r = table[i]!;
    if (r.every((c) => !c.trim())) continue;
    const line = i + 1;
    const techNo = at(r, 'techNo');
    const name = at(r, 'name');
    const problems: string[] = [];
    if (!/^[0-9A-Za-z]{1,6}$/.test(techNo)) problems.push(`技师号「${techNo}」应为 1–6 位字母或数字`);
    else if (seen.has(techNo)) problems.push(`技师号 ${techNo} 与第 ${seen.get(techNo)} 行重复`);
    if (!name || name.length > 16) problems.push('姓名应为 1–16 个字');
    const gender = GENDERS[norm(at(r, 'gender'))];
    if (!gender && !(opts.genderOptional && !at(r, 'gender'))) problems.push(`性别「${at(r, 'gender') || '空'}」应为 男 / 女`);
    const gradeText = norm(at(r, 'grade'));
    const grade = gradeText ? (GRADES[gradeText] ?? opts.gradeMap?.[gradeText]) : 'standard';
    if (!grade) problems.push(`技师等级「${at(r, 'grade')}」应为 标准 / 专业 / 优选（旧系统的星级用 --grade-map 对照，如 一星=标准）`);
    const group = at(r, 'group') || null;
    if (group && group.length > 16) problems.push('技师组别最多 16 个字');
    const nickname = at(r, 'nickname');
    if (nickname.length > 16) problems.push('昵称最多 16 个字');
    const hiredOn = legacyDate(at(r, 'hiredOn'));
    if (hiredOn === undefined) problems.push(`入职日期「${at(r, 'hiredOn')}」认不出来`);
    const phone = parsePhone(at(r, 'phone'));
    if (phone === undefined) problems.push(`电话「${at(r, 'phone')}」应为 11 位手机号`);
    const heightCm = parseHeight(at(r, 'height'));
    if (heightCm === undefined) problems.push(`身高「${at(r, 'height')}」应为 100–230 厘米`);
    const weightKg = parseWeight(at(r, 'weight'));
    if (weightKg === undefined) problems.push(`体重「${at(r, 'weight')}」应为 30–200 公斤（写「斤」的按一半算）`);
    const star = parseStar(at(r, 'star'));
    if (star === undefined) problems.push(`星级「${at(r, 'star')}」应为 1–10（如 3、3星、三星）`);
    if (problems.length) {
      errors.push({ line, message: problems.join('；') });
      continue;
    }
    seen.set(techNo, line);
    rows.push({
      line,
      techNo,
      name,
      gender: gender ?? null,
      grade: grade!,
      group,
      nickname,
      hiredOn: hiredOn ?? null,
      phone: phone ?? null,
      heightCm: heightCm ?? null,
      weightKg: weightKg ?? null,
      star: star ?? null,
    });
  }
  if (rows.length + errors.length > TECHNICIAN_IMPORT_MAX_ROWS) {
    return { rows: [], errors: [{ line: 1, message: `一次最多 ${TECHNICIAN_IMPORT_MAX_ROWS} 位技师` }] };
  }
  return { rows, errors };
}
