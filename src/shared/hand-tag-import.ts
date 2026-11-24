// 柜号清单导入（店主 2026-10-27 #26：按清单逐个导入，不按号段生成）。前台页面与命令行共用的 CSV 解析。
//
// 格式与 docs/data/hand-tags-2026-10-27.csv 相同：code,gender,kind,area,vip_level
//   · code：牌号，普通柜连区号字母（A8060），VIP 柜为纯数字（9058）；
//   · gender：male / female（也接受 男、女、男宾、女宾）；
//   · kind：normal / vip（也接受 普通、普通柜、VIP、VIP柜）；
//   · area：普通柜的区号，可留空；填写时必须与牌号的字母前缀一致；
//   · vip_level：VIP 柜的等级（1–9），普通柜留空；
//   · card_uid：芯片号（8.1.35，可选；刷卡带出牌号用，4–32 位数字或字母，同一份清单里不能重复）。
// 8.1.35（福田迁移，docs/FUTIAN_MIGRATION.md 第 2.8 节）：也认旧收银系统「手牌管理导入模板」的表头——手牌号、手牌ID、性别、手牌类型；
// 旧的手牌类型（散客 / 儿童 / 便衣客 / 公司内部 / 虚拟）本系统没有，一律当普通柜；手牌区域（T 区、共用柜……）与牌号前缀对不上，不导。

import { MAX_VIP_LEVEL, normalizeTagCode, tagArea, TAG_CODE_PATTERN, type TagKind, type Zone } from './frontdesk';
import { readCsvTable, unclosedQuoteMessage } from './csv-read';
import { CARD_UID_PATTERN, normalizeCardUid } from './frontdesk-risk';

export interface HandTagImportRow {
  code: string;
  zone: Zone;
  kind: TagKind;
  vipLevel: number | null;
  /** 芯片号；清单没有这一列为 undefined（不动已有的），空为 null */
  cardUid?: string | null;
}

export interface HandTagCsvResult {
  rows: HandTagImportRow[];
  /** 行号从 1 开始（含表头） */
  errors: { line: number; message: string }[];
}

export const HAND_TAG_IMPORT_MAX_ROWS = 2000;

const HEADER_ALIASES: Record<string, string[]> = {
  code: ['code', '牌号', '柜号', '手牌号'],
  gender: ['gender', 'zone', '性别', '分区'],
  kind: ['kind', '柜型', '类型', '手牌类型'],
  area: ['area', '区', '区号'],
  vip_level: ['vip_level', 'level', '等级', 'vip等级'],
  card_uid: ['card_uid', '芯片号', '手牌id'],
};

const ZONE_VALUES: Record<string, Zone> = { male: 'male', female: 'female', 男: 'male', 女: 'female', 男宾: 'male', 女宾: 'female' };
const KIND_VALUES: Record<string, TagKind> = {
  normal: 'normal',
  vip: 'vip',
  普通: 'normal',
  普通柜: 'normal',
  vip柜: 'vip',
  // 旧收银系统的手牌类型（福田迁移）：本系统没有这些分类，都当普通柜
  散客: 'normal',
  儿童: 'normal',
  便衣客: 'normal',
  公司内部: 'normal',
  虚拟: 'normal',
};

export function parseHandTagCsv(text: string): HandTagCsvResult {
  const table = readCsvTable(text);
  if (table.unclosedQuoteLine !== null) return { rows: [], errors: [{ line: table.unclosedQuoteLine, message: unclosedQuoteMessage(table.unclosedQuoteLine) }] };
  if (!table.header) return { rows: [], errors: [{ line: 1, message: '文件是空的' }] };
  return parseHandTagRecords(table.header, table.rows);
}

/** 表格（xlsx 读出来的每行单元格文字）：表头是第一个有「牌号 / 手牌号 / code」的行（前面的填写须知跳过） */
export function parseHandTagTable(table: string[][]): HandTagCsvResult {
  const norm = (c: string) => c.toLowerCase().replace(/\s+/g, '');
  const at = table.findIndex((r) => r.some((c) => HEADER_ALIASES.code!.includes(norm(c))));
  if (at < 0) return { rows: [], errors: [{ line: 1, message: '找不到表头（要有「牌号」或「手牌号」列）' }] };
  const records = table.slice(at + 1).flatMap((cells, i) => (cells.some((c) => c.trim()) ? [{ line: at + 2 + i, cells }] : []));
  return parseHandTagRecords({ line: at + 1, cells: table[at]! }, records);
}

function parseHandTagRecords(headerRecord: { line: number; cells: string[] }, records: { line: number; cells: string[] }[]): HandTagCsvResult {
  const errors: HandTagCsvResult['errors'] = [];
  const rows: HandTagImportRow[] = [];
  const headerLine = headerRecord.line;
  const header = headerRecord.cells.map((h) => h.toLowerCase().replace(/\s+/g, ''));
  const col: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = header.findIndex((h) => aliases.includes(h));
    if (i >= 0) col[key] = i;
  }
  for (const required of ['code', 'gender', 'kind'] as const) {
    if (col[required] === undefined) {
      errors.push({ line: headerLine, message: `表头缺少「${HEADER_ALIASES[required]![0]}」列（应为 code,gender,kind,area,vip_level）` });
    }
  }
  if (errors.length) return { rows, errors };

  const seen = new Map<string, number>();
  const seenUid = new Map<string, number>();
  for (const { line, cells } of records) {
    const cell = (key: string) => (col[key] === undefined ? '' : (cells[col[key]!] ?? ''));
    const code = normalizeTagCode(cell('code'));
    const zone = ZONE_VALUES[cell('gender').toLowerCase()];
    const kind = KIND_VALUES[cell('kind').toLowerCase().replace(/\s+/g, '')];
    const area = cell('area').toUpperCase();
    const levelText = cell('vip_level');
    const problems: string[] = [];
    if (!TAG_CODE_PATTERN.test(code)) problems.push(`牌号「${cell('code')}」格式不正确`);
    if (!zone) problems.push(`性别「${cell('gender')}」应为 male / female`);
    if (!kind) problems.push(`柜型「${cell('kind')}」应为 normal / vip`);
    let vipLevel: number | null = null;
    if (kind === 'vip') {
      vipLevel = Number(levelText);
      if (!/^\d+$/.test(levelText) || vipLevel < 1 || vipLevel > MAX_VIP_LEVEL) problems.push(`VIP 柜 ${code} 的等级应为 1–${MAX_VIP_LEVEL}`);
    } else if (kind === 'normal' && levelText !== '') {
      problems.push(`普通柜 ${code} 不应填写 VIP 等级`);
    }
    if (kind === 'normal' && area && area !== tagArea(code)) problems.push(`普通柜 ${code} 的区号「${area}」与牌号前缀不一致`);
    const dup = seen.get(code);
    if (dup !== undefined) problems.push(`牌号 ${code} 与第 ${dup} 行重复`);
    let cardUid: string | null | undefined;
    if (col.card_uid !== undefined) {
      cardUid = cell('card_uid').trim() ? normalizeCardUid(cell('card_uid')) : null;
      if (cardUid && !CARD_UID_PATTERN.test(cardUid)) problems.push(`芯片号「${cell('card_uid')}」应为 4–32 位数字或字母`);
      else if (cardUid && seenUid.has(cardUid)) problems.push(`芯片号 ${cardUid} 与第 ${seenUid.get(cardUid)} 行重复`);
    }
    if (problems.length) {
      errors.push({ line, message: problems.join('；') });
      continue;
    }
    seen.set(code, line);
    if (cardUid) seenUid.set(cardUid, line);
    rows.push(cardUid === undefined ? { code, zone: zone!, kind: kind!, vipLevel } : { code, zone: zone!, kind: kind!, vipLevel, cardUid });
  }
  if (rows.length === 0 && errors.length === 0) errors.push({ line: headerLine, message: '文件里没有柜号' });
  if (rows.length > HAND_TAG_IMPORT_MAX_ROWS) errors.push({ line: 1, message: `一次最多导入 ${HAND_TAG_IMPORT_MAX_ROWS} 个柜号` });
  return { rows, errors };
}

/** 导入结果（预览与正式导入相同） */
export interface HandTagImportReport {
  dryRun: boolean;
  total: number;
  created: number;
  /** 分区、柜型、等级有变化，或从停用恢复启用 */
  updated: number;
  unchanged: number;
  /** 勾选「停用清单外的手牌」时，被停用的张数 */
  deactivated: number;
  /** 在店手牌不改动（分区、柜型、等级有变化或要停用时） */
  blocked: { code: string; reason: string }[];
  samples: { created: string[]; updated: string[]; deactivated: string[] };
  /** 清单按分区 / 柜型 / 等级 / 区号汇总 */
  groups: { zone: Zone; kind: TagKind; vipLevel: number | null; area: string; count: number }[];
}
