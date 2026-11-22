// 出入库台账（8.1.20，docs/ERP_V8120.md，PENDING_DECISIONS「8.1.20」LD1–LD10）：「库管入库」页右上角的
// 「导入出入库台账」「导出台账」「下载模板」。代替 8.1.9 的「入库台账」模板（那个模板停用，direct-import.ts 只留着查回旧的导入）。
//
// 模板照门店的《库管出入库明细及库位表》（店主 2026-11-22 定：以门店给的表格格式为主，文件名「出入库台账」）：入库登记表格、
//   仓库库位表、物品借出备忘表三张。导入只读「仓库库位表」那种出入库记录（标题一行，表头两行：上一行「入库」「出库」是分组，
//   下一行是分组里的列，一种物料一行）：序号、日期、供应商、物料名称、规格、库位、上期库存量、入库 ×2（日期、数量）、
//   出库 ×3（日期、数量、领料人及部门）、库存量、备注；一个文件几张表时认表头两行、有入库出库分组的那一张。
// 导入：入库生成库管入库（按「日期 + 供应商」合单，单价取档案的参考价；表里自己加了「单价」列的取表里写的），出库生成部门领料
//   （按「日期 + 部门 + 领料人」合单），都马上生效；同一天先入库后出库。上期库存量、库存量只核对、不挡导入。
//   表里写了库位的，写进物料档案。有一行有问题整份不写；同一份文件（按内容摘要）只能导入一次；系统导出的台账不能导入。
// 加锁：操作编号的咨询锁（业务类型 ledger_import，与「确认作废」串行）→ 同一份文件的咨询锁 → 写导入记录 →
//   按日期取好全部单号（单号计数，与新建单据同一顺序）→ 按 id 升序锁住这次要动的全部物料（写库位也在这里）→
//   逐张建单、生效（每张单原来的锁：物料 → 部门小仓的结存行 → 部门行）。

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  LEDGER_COLUMNS,
  LEDGER_EXPORT_MARK,
  LEDGER_IN_SLOTS,
  LEDGER_LINES_PER_DOC,
  LEDGER_MAX_DOCS,
  LEDGER_MAX_GROUPS,
  LEDGER_MAX_ROWS,
  LEDGER_OUT_SLOTS,
  LEDGER_TAIL_COLUMNS,
  type LedgerImportDoc,
  type LedgerImportPreview,
  type LedgerImportResult,
  type LedgerImportRow,
  type LedgerInEvent,
  type LedgerOutEvent,
} from '@shared/ledger-import';
import { parseYuan } from '@shared/money';
import { lineAmountCents } from '@shared/quantity';
import { readSnapshot, type Db } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { attachment } from '../../lib/csv';
import { todayIn } from '../../lib/dates';
import { conflict, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { parseCsv } from '../../lib/sheet-read';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { buildWorkbook, colName, type WbCell, type WbSheet } from '../../lib/xlsx';
import { readXlsx, serialToDate, XlsxReadError } from '../../lib/xlsx-read';
import { erpOpAbandoned } from '../erp-ops';
import { isoDate } from '../request-import';
import { loadInventorySettings } from './common';
import { createLedgerDoc, nextIssueNo, nextReceiptNo } from './docs';

const FileFields = z.object({
  fileName: z.string().trim().min(1, '缺少文件名').max(120, '文件名太长'),
  csv: z.string().max(2_000_000, '文件太大，请分批导入').optional(),
  xlsxBase64: z.string().max(2_800_000, '文件太大，请分批导入').optional(),
});
const oneFile = (f: { csv?: string; xlsxBase64?: string }) => !!f.csv !== !!f.xlsxBase64;
const PreviewInput = FileFields.refine(oneFile, { message: '请选择一个 Excel 或 CSV 文件', path: ['csv'] });
const ApplyInput = FileFields.extend({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  /** 用户看过的那次预览的摘要：导入时在锁里重新核对一遍，与它不一样（预览以后档案、参考价、结存变过）整份不导 */
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/, '请先预览，核对后再导入'),
}).refine(oneFile, {
  message: '请选择一个 Excel 或 CSV 文件',
  path: ['csv'],
});
const ExportQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份写成 2026-11 这样') });

// ───────────────────────── 读文件 ─────────────────────────

interface Cell {
  text: string;
  /** Excel 里存成数字（日期序号、数量） */
  number: boolean;
  /** 公式算错了（#REF! 之类） */
  error: boolean;
}

interface LedgerSheet {
  sha256: string;
  title: string;
  /** 列：名字 → 列号；入库、出库按组 */
  cols: Map<string, number>;
  ins: { date: number; qty: number }[];
  outs: { date: number; qty: number; who: number }[];
  rows: { row: number; cells: Cell[] }[];
}

const SYNONYM: Record<string, string> = {
  物品名称: '物料名称',
  名称: '物料名称',
  规格型号: '规格',
  接手存量: '上期库存量',
  上月库存量: '上期库存量',
  期初库存量: '上期库存量',
  结存: '库存量',
  期末库存量: '库存量',
  '单价（元）': '单价',
  部门及领料人: '领料人及部门',
  领料人: '领料人及部门',
  出库数量: '数量',
  入库数量: '数量',
  '备注（部门）': '备注',
};
const norm = (t: string) => {
  const s = t.replace(/\s+/g, '').trim();
  return SYNONYM[s] ?? s;
};

type Grid = { row: number; cells: Cell[] }[];

/** 表头：前 10 行里第一行同时有「序号」「物料名称」的；twoRows：下一行有「日期」「数量」（分组的第二行表头） */
function headerOf(grid: Grid): { at: number; twoRows: boolean } | null {
  const at = grid.slice(0, 10).findIndex((r) => {
    const names = r.cells.map((c) => norm(c.text));
    return names.includes('序号') && names.includes('物料名称');
  });
  if (at < 0) return null;
  const sub = (grid[at + 1]?.cells ?? []).map((c) => norm(c.text));
  return { at, twoRows: sub.includes('日期') && sub.includes('数量') };
}

/**
 * 认表头与入库、出库的组。两种版式都认：
 *   - 两行表头（8.1.20 的模板、门店当月的「仓库库位表郑」）：上一行「入库」「出库」是分组，下一行是组里的「日期」「数量」「领料人及部门」；
 *   - 一行表头（门店给的模板「仓库库位表」，2026-11-22）：「出库数量」「日期」「部门及领料人 / 领料人及部门」三列一组；
 *     「入库」一列是入库数量，后面紧跟着「日期」的算它的日期，没有的话入库日期取这一行第 2 列的「日期」（groupless，date = -1）
 */
function parseGrid(grid: Grid): Omit<LedgerSheet, 'sha256'> | null {
  const head = headerOf(grid);
  if (!head) return null;
  const { at, twoRows } = head;
  const raw = grid[at]!.cells.map((c) => c.text.replace(/\s+/g, ''));
  const top = grid[at]!.cells.map((c) => norm(c.text));
  const subCells = (grid[at + 1]?.cells ?? []).map((c) => norm(c.text));
  const width = Math.max(top.length, twoRows ? subCells.length : 0);
  const cols = new Map<string, number>();
  const ins: LedgerSheet['ins'] = [];
  const outs: LedgerSheet['outs'] = [];
  let group = '';
  let current: { kind: 'in' | 'out'; date: number; qty: number; who: number } | null = null;
  const flush = () => {
    if (!current) return;
    if (current.kind === 'in' && current.qty >= 0 && (current.date >= 0 || !twoRows)) ins.push({ date: current.date, qty: current.qty });
    if (current.kind === 'out' && current.date >= 0 && current.qty >= 0) outs.push({ date: current.date, qty: current.qty, who: current.who });
    current = null;
  };
  for (let c = 0; c < width; c++) {
    const t = top[c] ?? '';
    if (twoRows) {
      const s = subCells[c] ?? '';
      if (t) group = t;
      if (s && (group === '入库' || group === '出库')) {
        const kind = group === '入库' ? 'in' : 'out';
        if (s === '日期') {
          flush();
          current = { kind, date: c, qty: -1, who: -1 };
        } else if (current && current.kind === kind) {
          if (s === '数量') current.qty = c;
          else if (s === '领料人及部门') current.who = c;
        }
        continue;
      }
    } else {
      const r = raw[c] ?? '';
      if (r === '入库' || r === '入库数量' || r === '出库' || r === '出库数量') {
        flush();
        current = { kind: r.startsWith('入库') ? 'in' : 'out', date: -1, qty: c, who: -1 };
        continue;
      }
      if (current && t === '日期' && current.date < 0) {
        current.date = c;
        continue;
      }
      if (current?.kind === 'out' && t === '领料人及部门' && current.who < 0) {
        current.who = c;
        continue;
      }
    }
    flush();
    if (t && !cols.has(t)) cols.set(t, c);
  }
  flush();
  const title =
    at > 0
      ? grid
          .slice(0, at)
          .map((r) =>
            r.cells
              .map((c) => c.text)
              .filter(Boolean)
              .join(' '),
          )
          .join(' ')
      : '';
  return { title, cols, ins, outs, rows: grid.slice(at + (twoRows ? 2 : 1)) };
}

function readLedger(f: { csv?: string; xlsxBase64?: string }): LedgerSheet {
  let grids: Grid[];
  let sha256: string;
  if (f.csv !== undefined) {
    sha256 = createHash('sha256').update(f.csv, 'utf8').digest('hex');
    grids = [
      parseCsv(f.csv.replace(/^\uFEFF/, ''))
        .map((r) => ({ row: r.line, cells: r.cells.map((c) => ({ text: c.trim(), number: false, error: false })) }))
        .filter((r) => r.cells.some((c) => c.text !== '')),
    ];
  } else {
    const buf = Buffer.from(f.xlsxBase64!, 'base64');
    sha256 = createHash('sha256').update(buf).digest('hex');
    let book;
    try {
      book = readXlsx(buf);
    } catch (error) {
      if (error instanceof XlsxReadError) throw unprocessable('IMPORT_FILE_INVALID', error.message);
      throw error;
    }
    if (book.sheets.length === 0) throw unprocessable('IMPORT_EMPTY', 'Excel 文件里没有工作表');
    grids = book.sheets.map((sheet) =>
      [...sheet.rows.keys()]
        .sort((a, b) => a - b)
        .map((r) => {
          const line = sheet.rows.get(r)!;
          const width = line.size ? Math.max(...line.keys()) + 1 : 0;
          return {
            row: r,
            cells: Array.from({ length: width }, (_, c) => {
              const cell = line.get(c);
              return { text: (cell?.value ?? '').trim(), number: cell?.type === 'number', error: cell?.type === 'error' };
            }),
          };
        })
        .filter((r) => r.cells.some((c) => c.text !== '')),
    );
  }
  if (grids.every((g) => g.length === 0)) throw unprocessable('IMPORT_EMPTY', '文件是空的');
  // 门店的《库管出入库明细及库位表》一个文件好几张表（入库登记表格、仓库库位表、物品借出备忘表、各月的仓库库位表……）：
  // 只读出入库记录——有入库、出库的组、而且填了物料的第一张；都没填时取第一张有入库出库组的；再退回第一张有表头的
  // （店主 2026-11-22：入库登记表格不导入）
  const parsed = grids.map(parseGrid);
  const hasGroups = (p: ReturnType<typeof parseGrid>) => !!p && p.ins.length + p.outs.length > 0;
  const filled = (p: ReturnType<typeof parseGrid>) => {
    const i = p?.cols.get('物料名称');
    return i !== undefined && p!.rows.some((r) => (r.cells[i]?.text ?? '') !== '');
  };
  const sheet = parsed.find((p) => hasGroups(p) && filled(p)) ?? parsed.find(hasGroups) ?? parsed.find((p) => !!p);
  if (!sheet) {
    throw unprocessable('IMPORT_COLUMNS', '没找到出入库记录的表头（要有「序号」「物料名称」两列）。请用「下载模板」里的出入库台账（仓库库位表）');
  }
  return { sha256, ...sheet };
}

// ───────────────────────── 逐行核对 ─────────────────────────

interface Mat {
  id: number;
  code: string;
  name: string;
  specification: string;
  inventoryUnit: string;
  purchaseUnit: string;
  purchaseFactorMilli: number;
  decimals: number;
  refPriceCents: number | null;
  stockMilli: number;
  location: string;
  expiryTracked: boolean;
}

/** 数量：大于 0、最多 3 位小数（千分之一） */
function qtyOf(text: string): number | null {
  const t = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const v = Math.round(Number(t) * 1000);
  return v > 0 && v <= 1_000_000_000 ? v : null;
}
/** 上期库存量、库存量：可以是 0 */
function stockOf(text: string): number | null {
  const t = text.replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d{1,3})?$/.test(t)) return null;
  return Math.round(Number(t) * 1000);
}
const showQty = (milli: number) => (milli / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });

/** 日期：2026-11-18、2026/11/18、Excel 的日期；也认「11月18日」「11.18」「11/18」（年份取标题里的，没有取今年） */
function dateOf(cell: Cell, year: string): string | null {
  if (!cell.text) return null;
  if (cell.number && /^\d+(\.\d+)?$/.test(cell.text) && Number(cell.text) > 1000) return serialToDate(Number(cell.text));
  const full = isoDate(cell.text);
  if (full) return full;
  const m = /^(\d{1,2})[./月-](\d{1,2})日?$/.exec(cell.text);
  if (!m) return null;
  return isoDate(`${year}-${m[1]}-${m[2]}`);
}

async function plan(db: Db, f: z.infer<typeof PreviewInput>, timezone: string): Promise<LedgerImportPreview> {
  const sheet = readLedger(f);
  if (sheet.title.includes(LEDGER_EXPORT_MARK)) {
    throw unprocessable('IMPORT_EXPORTED', '这是系统导出的台账（只用来对账），里面的出入库已经记过账，再导入会重复记账。请用「下载模板」填新发生的出入库');
  }
  if (!sheet.cols.has('物料名称')) throw unprocessable('IMPORT_COLUMNS', '表头少了「物料名称」');
  if (sheet.ins.length > LEDGER_MAX_GROUPS || sheet.outs.length > LEDGER_MAX_GROUPS) {
    throw unprocessable('IMPORT_TOO_MANY', `入库、出库各最多 ${LEDGER_MAX_GROUPS} 组（这份入库 ${sheet.ins.length} 组、出库 ${sheet.outs.length} 组），请按月分成几份导入`);
  }
  if (sheet.ins.length === 0 && sheet.outs.length === 0) {
    throw unprocessable('IMPORT_COLUMNS', '表头里没有入库、出库的列（要有「入库」「出库数量」，或两行表头的「入库」「出库」分组），请用「下载模板」里的出入库台账（仓库库位表）');
  }
  const cell = (cells: Cell[], i: number): Cell => cells[i] ?? { text: '', number: false, error: false };
  const named = (cells: Cell[], name: string): Cell => {
    const i = sheet.cols.get(name);
    return i === undefined ? { text: '', number: false, error: false } : cell(cells, i);
  };
  // 要导入的行：写了物料，或者入库、出库里填了东西
  const rows = sheet.rows.filter(
    (r) =>
      named(r.cells, '物料名称').text !== '' ||
      sheet.ins.some((s) => cell(r.cells, s.qty).text !== '' || cell(r.cells, s.date).text !== '') ||
      sheet.outs.some((s) => cell(r.cells, s.qty).text !== '' || cell(r.cells, s.date).text !== ''),
  );
  if (rows.length === 0) throw unprocessable('IMPORT_EMPTY', '文件里没有要导入的行');
  if (rows.length > LEDGER_MAX_ROWS) throw unprocessable('IMPORT_TOO_MANY', `一份文件最多 ${LEDGER_MAX_ROWS} 行，请分批导入`);

  const today = todayIn(timezone);
  const year = /(\d{4})\s*年/.exec(sheet.title)?.[1] ?? today.slice(0, 4);
  const settings = await loadInventorySettings(db);
  const suppliers = await db<{ id: number; code: string; name: string }[]>`SELECT id, code, name FROM suppliers WHERE active`;
  const supByCode = new Map(suppliers.map((s) => [s.code.trim().toUpperCase(), s]));
  const supByName = new Map<string, (typeof suppliers)[number][]>();
  for (const s of suppliers) supByName.set(s.name.trim(), [...(supByName.get(s.name.trim()) ?? []), s]);
  const mats = await db<Mat[]>`
    SELECT id, code, name, specification, inventory_unit, purchase_unit, purchase_factor_milli, decimals, ref_price_cents, stock_milli, location, expiry_tracked
    FROM materials WHERE active AND tracked`;
  const matByCode = new Map(mats.map((m) => [m.code.trim().toUpperCase(), m]));
  const matByName = new Map<string, Mat[]>();
  for (const m of mats) matByName.set(m.name.trim(), [...(matByName.get(m.name.trim()) ?? []), m]);
  const depts = await db<{ id: number; name: string }[]>`SELECT id, name FROM departments WHERE active ORDER BY char_length(name) DESC, id`;

  const out: LedgerImportRow[] = rows.map((r) => {
    const issues: string[] = [];
    const warnings: string[] = [];
    if (!settings.directReceipt) issues.push('库管入库已在库存设置里关掉');
    // 物料：物料编号（有这一列时）优先，其次名称；同名的按规格分
    const name = named(r.cells, '物料名称').text;
    const code = named(r.cells, '物料编号').text;
    const spec = named(r.cells, '规格').text;
    let material: Mat | null = null;
    if (code) {
      material = matByCode.get(code.toUpperCase()) ?? null;
      if (!material) issues.push(`物料编号：「${code}」不在物料档案里（或已停用、不是受管物料）`);
    } else if (!name) issues.push('物料名称：没填');
    else {
      let found = matByName.get(name) ?? [];
      if (found.length > 1 && spec) found = found.filter((m) => m.specification.trim() === spec);
      if (found.length === 0) issues.push(`物料名称：「${name}」${spec ? `（规格 ${spec}）` : ''}不在物料档案里；先在库存「档案 → 物料」里建档`);
      else if (found.length > 1) issues.push(`物料名称：档案里有 ${found.length} 个「${name}」，请在「规格」写清是哪一个（${found.map((m) => m.specification || m.code).join('、')}）`);
      else material = found[0]!;
    }
    const decimalsOk = (milli: number) => !material || milli % 10 ** (3 - material.decimals) === 0;
    // 入库
    const insEv: LedgerInEvent[] = [];
    sheet.ins.forEach((s, i) => {
      // 一行表头的「入库」一列没有自己的日期：取这一行第 2 列的「日期」
      const d = s.date >= 0 ? cell(r.cells, s.date) : named(r.cells, '日期');
      const q = cell(r.cells, s.qty);
      // 借来的「日期」那一列也写着别的（盘点接手的日期之类）：入库数量没写就不算这一行有入库
      if (!q.text && (s.date < 0 || !d.text)) return;
      const label = `入库${sheet.ins.length > 1 ? ` 第 ${i + 1} 组` : ''}`;
      const date = dateOf(d, year);
      const qtyMilli = qtyOf(q.text);
      if (!d.text) issues.push(`${label}：写了数量没写日期${s.date < 0 ? '（入库的日期写在第 2 列「日期」）' : ''}`);
      else if (!date) issues.push(`${label}：日期「${d.text}」看不懂（写成 2026-11-18 或 11月18日）`);
      else if (date > today) issues.push(`${label}：日期不能晚于今天`);
      if (!q.text) issues.push(`${label}：写了日期没写数量`);
      else if (qtyMilli === null) issues.push(`${label}：数量「${q.text}」不对（要大于 0，最多 3 位小数）`);
      else if (!decimalsOk(qtyMilli)) issues.push(`${label}：「${material!.name}」最多 ${material!.decimals} 位小数`);
      insEv.push({ slot: i + 1, date, qtyMilli });
    });
    // 出库
    const outsEv: LedgerOutEvent[] = [];
    sheet.outs.forEach((s, i) => {
      const d = cell(r.cells, s.date);
      const q = cell(r.cells, s.qty);
      const w = s.who >= 0 ? cell(r.cells, s.who).text : '';
      if (!d.text && !q.text && !w) return;
      const label = `出库${sheet.outs.length > 1 ? ` 第 ${i + 1} 组` : ''}`;
      const date = dateOf(d, year);
      const qtyMilli = qtyOf(q.text);
      if (!d.text) issues.push(`${label}：没写日期`);
      else if (!date) issues.push(`${label}：日期「${d.text}」看不懂（写成 2026-11-18 或 11月18日）`);
      else if (date > today) issues.push(`${label}：日期不能晚于今天`);
      if (!q.text) issues.push(`${label}：没写数量`);
      else if (qtyMilli === null) issues.push(`${label}：数量「${q.text}」不对（要大于 0，最多 3 位小数）`);
      else if (!decimalsOk(qtyMilli)) issues.push(`${label}：「${material!.name}」最多 ${material!.decimals} 位小数`);
      // 领料人及部门：认部门档案里的名称（名字长的先认，「客房部」先于「客房」）
      const department = w ? (depts.find((x) => w.includes(x.name)) ?? null) : null;
      if (!w) issues.push(`${label}：没写领料人及部门`);
      else if (!department) issues.push(`${label}：「${w}」里没认出部门（要写部门档案里的名称，如「${depts[0]?.name ?? '客房部'} 张三」）`);
      const receiver = department
        ? w
            .replace(department.name, '')
            .replace(/^[\s\-—·:：,，、/()（）]+|[\s\-—·:：,，、/()（）]+$/g, '')
            .slice(0, 32)
        : '';
      outsEv.push({ slot: i + 1, date, qtyMilli, who: w, department: department ? { id: Number(department.id), name: department.name } : null, receiver: receiver || (department?.name ?? '') });
    });
    if (material && insEv.length === 0 && outsEv.length === 0) warnings.push('这一行没有入库也没有出库，只核对库存量');
    // 供应商：有入库才要
    const supText = named(r.cells, '供应商').text;
    let supplier: (typeof suppliers)[number] | null = null;
    if (insEv.length) {
      if (!supText) issues.push('供应商：有入库，要写供应商');
      else {
        supplier = supByCode.get(supText.toUpperCase()) ?? null;
        if (!supplier) {
          const found = supByName.get(supText) ?? [];
          if (found.length === 1) supplier = found[0]!;
          else if (found.length > 1) issues.push(`供应商：档案里有 ${found.length} 个「${supText}」，请写供应商编号（${found.map((s) => s.code).join('、')}）`);
          else issues.push(`供应商：「${supText}」不在供应商档案里（或已停用）；先在「供应商」里建档`);
        }
      }
    }
    // 单价：元，每采购单位；没写取档案的参考价
    const priceText = named(r.cells, '单价').text;
    let priceCents: number | null = null;
    let priceFromRef = false;
    if (priceText) {
      priceCents = parseYuan(priceText);
      if (priceCents === null || priceCents < 0) {
        issues.push(`单价：「${priceText}」不对（写元，最多 2 位小数）`);
        priceCents = null;
      } else if (priceCents > 100_000_000) issues.push('单价：太大了（最多 100 万元）');
    } else if (material && material.refPriceCents !== null) {
      priceCents = Number(material.refPriceCents);
      priceFromRef = true;
    } else if (insEv.length && material) issues.push(`单价：「${material.name}」的物料档案里没有参考价；先在库存「档案 → 物料」里填参考价（或在表里加一列「单价」写上）`);
    if (material?.expiryTracked && insEv.length) issues.push(`「${material.name}」管效期，入库要填到期日，台账里没有这一列；请在「库管入库」里逐张登记`);
    const inMilli = insEv.reduce((t, e) => t + (e.qtyMilli ?? 0), 0);
    const outMilli = outsEv.reduce((t, e) => t + (e.qtyMilli ?? 0), 0);
    const amountCents = material && priceCents !== null && inMilli > 0 ? lineAmountCents(inMilli, priceCents, Number(material.purchaseFactorMilli)) : 0;
    // 库位
    const location = named(r.cells, '库位').text;
    if (location.length > 20) issues.push('库位：最多 20 个字');
    // 上期库存量、库存量：只核对
    const openCell = named(r.cells, '上期库存量');
    const closeCell = named(r.cells, '库存量');
    const open = openCell.text ? stockOf(openCell.text) : null;
    const close = closeCell.text ? stockOf(closeCell.text) : null;
    if (openCell.text && open === null) warnings.push(`上期库存量「${openCell.text}」看不懂，没有核对`);
    if (closeCell.text && close === null) warnings.push(`库存量「${closeCell.text}」看不懂，没有核对`);
    if (material && open !== null && open !== Number(material.stockMilli)) {
      warnings.push(`上期库存量写的 ${showQty(open)}，系统里现在是 ${showQty(Number(material.stockMilli))}${material.inventoryUnit}`);
    }
    if (open !== null && close !== null && open + inMilli - outMilli !== close) {
      warnings.push(`库存量写的 ${showQty(close)}，上期 ${showQty(open)} + 入库 ${showQty(inMilli)} − 出库 ${showQty(outMilli)} = ${showQty(open + inMilli - outMilli)}`);
    }
    const note = named(r.cells, '备注').text.slice(0, 100);
    return {
      row: r.row,
      seq: named(r.cells, '序号').text,
      material: material ? { id: Number(material.id), code: material.code, name: material.name, inventoryUnit: material.inventoryUnit, purchaseUnit: material.purchaseUnit } : null,
      supplier: supplier ? { id: Number(supplier.id), code: supplier.code, name: supplier.name } : null,
      location,
      locationBefore: material?.location ?? '',
      priceCents,
      priceFromRef,
      ins: insEv,
      outs: outsEv,
      inMilli,
      outMilli,
      amountCents,
      note,
      issues,
      warnings,
    };
  });
  // 同一种物料写了两行：合单时会算到一起，提醒一下
  const seen = new Map<number, LedgerImportRow>();
  // 每种物料第一行有入库的（不一定是这种物料的第一行）：后面有入库的行都与它比单价
  const firstIn = new Map<number, LedgerImportRow>();
  for (const r of out) {
    if (!r.material) continue;
    const first = seen.get(r.material.id);
    if (!first) seen.set(r.material.id, r);
    else r.warnings.push(`「${r.material.name}」在第 ${first.row} 行也有，两行的出入库都会记`);
    if (!r.ins.length) continue;
    const fi = firstIn.get(r.material.id);
    if (!fi) firstIn.set(r.material.id, r);
    // 合单时同一张库管入库里同一种物料只有一行：两行都有入库、单价又不一样的，分不清按哪个价
    else if (r.priceCents !== fi.priceCents) {
      r.issues.push(`单价：「${r.material.name}」在第 ${fi.row} 行也有入库，两行的单价不一样；请合成一行，或写同一个单价`);
    }
  }
  // 按日期走一遍总仓结存：出库不能比当时的库存多（同一天先入库后出库）
  if (!out.some((r) => r.issues.length)) {
    const stock = new Map(mats.map((m) => [Number(m.id), Number(m.stockMilli)]));
    const events = out.flatMap((r) => [...r.ins.map((e) => ({ r, date: e.date!, order: 0, delta: e.qtyMilli! })), ...r.outs.map((e) => ({ r, date: e.date!, order: 1, delta: -e.qtyMilli! }))]);
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
    for (const e of events) {
      const id = e.r.material!.id;
      const next = stock.get(id)! + e.delta;
      stock.set(id, next);
      if (next < 0 && !e.r.issues.some((x) => x.startsWith('出库：库存不够'))) {
        e.r.issues.push(`出库：库存不够——${e.date} 出库以后总仓要变成 ${showQty(next)}${e.r.material!.inventoryUnit}（先导入入库，或改出库数量）`);
      }
    }
  }
  const issueCount = out.filter((r) => r.issues.length).length;
  const docs = issueCount ? [] : docsOf(out, factorsOf(mats)).map((d) => d.summary);
  if (docs.length > LEDGER_MAX_DOCS) {
    throw unprocessable('IMPORT_TOO_MANY', `这份台账要生成 ${docs.length} 张单，一份最多 ${LEDGER_MAX_DOCS} 张；请按日期分成几份导入`);
  }
  const [prev] = await db<{ id: number; createdAt: string; createdByName: string; receiptCount: number; issueCount: number }[]>`
    SELECT i.id, i.created_at, s.display_name AS created_by_name, i.receipt_count, i.issue_count FROM ledger_imports i JOIN staff s ON s.id = i.created_by
    WHERE i.file_sha256 = ${sheet.sha256}`;
  return {
    fileName: f.fileName,
    sha256: sheet.sha256,
    title: sheet.title,
    rows: out,
    digest: createHash('sha256')
      .update(JSON.stringify({ rows: out, docs }))
      .digest('hex'),
    docs,
    issueCount,
    warningCount: out.filter((r) => r.warnings.length).length,
    // 按合成以后的单据汇总（每张单每一行各自取整，与生成的收货单、应付一致）
    amountCents: docs.reduce((t, d) => t + d.amountCents, 0),
    previous: prev ? { id: Number(prev.id), createdAt: prev.createdAt, createdByName: prev.createdByName, receiptCount: Number(prev.receiptCount), issueCount: Number(prev.issueCount) } : null,
  };
}

const factorsOf = (mats: Pick<Mat, 'id' | 'purchaseFactorMilli'>[]) => new Map(mats.map((m) => [Number(m.id), Number(m.purchaseFactorMilli)]));

interface PlannedLine {
  materialId: number;
  qtyMilli: number;
  priceCents: number;
  note: string;
}
interface PlannedDoc {
  kind: 'receipt' | 'issue';
  docDate: string;
  supplierId: number | null;
  departmentId: number | null;
  receiver: string;
  lines: PlannedLine[];
  summary: LedgerImportDoc;
}

/**
 * 合单：入库按「日期 + 供应商」、出库按「日期 + 部门 + 领料人」（按第一次出现的顺序）；同一张单里同一种物料的数量加在一起，
 * 一张最多 100 行，超过的按顺序拆开。排好的顺序：日期从早到晚，同一天先入库后出库。
 */
function docsOf(rows: LedgerImportRow[], factors: Map<number, number>): PlannedDoc[] {
  const groups = new Map<string, Omit<PlannedDoc, 'summary'> & { byMat: Map<number, PlannedLine> }>();
  const add = (key: string, base: Omit<PlannedDoc, 'summary' | 'lines'>, line: PlannedLine) => {
    let g = groups.get(key);
    if (!g) {
      g = { ...base, lines: [], byMat: new Map() };
      groups.set(key, g);
    }
    const had = g.byMat.get(line.materialId);
    if (had) had.qtyMilli += line.qtyMilli;
    else {
      g.byMat.set(line.materialId, line);
      g.lines.push(line);
    }
  };
  for (const r of rows) {
    const seq = r.seq ? `序号 ${r.seq}` : `第 ${r.row} 行`;
    for (const e of r.ins) {
      add(
        `r|${e.date}|${r.supplier!.id}`,
        { kind: 'receipt', docDate: e.date!, supplierId: r.supplier!.id, departmentId: null, receiver: '' },
        { materialId: r.material!.id, qtyMilli: e.qtyMilli!, priceCents: r.priceCents!, note: [seq, r.note].filter(Boolean).join(' · ').slice(0, 100) },
      );
    }
    for (const e of r.outs) {
      add(
        `i|${e.date}|${e.department!.id}|${e.receiver}`,
        { kind: 'issue', docDate: e.date!, supplierId: null, departmentId: e.department!.id, receiver: e.receiver },
        { materialId: r.material!.id, qtyMilli: e.qtyMilli!, priceCents: 0, note: seq.slice(0, 100) },
      );
    }
  }
  const names = new Map<number, string>();
  for (const r of rows) {
    if (r.supplier) names.set(-r.supplier.id, r.supplier.name);
    for (const e of r.outs) if (e.department) names.set(e.department.id, e.department.name);
  }
  const out: PlannedDoc[] = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.lines.length; i += LEDGER_LINES_PER_DOC) {
      const lines = g.lines.slice(i, i + LEDGER_LINES_PER_DOC);
      const amountCents = g.kind === 'receipt' ? lines.reduce((t, l) => t + lineAmountCents(l.qtyMilli, l.priceCents, factors.get(l.materialId)!), 0) : 0;
      out.push({
        kind: g.kind,
        docDate: g.docDate,
        supplierId: g.supplierId,
        departmentId: g.departmentId,
        receiver: g.receiver,
        lines,
        summary: {
          kind: g.kind,
          docDate: g.docDate,
          party: g.kind === 'receipt' ? names.get(-g.supplierId!)! : names.get(g.departmentId!)!,
          receiver: g.receiver,
          lines: lines.length,
          amountCents,
        },
      });
    }
  }
  out.sort((a, b) => (a.docDate < b.docDate ? -1 : a.docDate > b.docDate ? 1 : a.kind === b.kind ? 0 : a.kind === 'receipt' ? -1 : 1));
  return out;
}

export async function previewLedgerImport(deps: Deps, raw: unknown): Promise<LedgerImportPreview> {
  return plan(deps.sql, parse(PreviewInput, raw), deps.config.timezone);
}

export async function ledgerImportResult(db: Db, importId: number, replayed: boolean): Promise<LedgerImportResult> {
  const [imp] = await db<LedgerImportResult['import'][]>`
    SELECT i.id, i.file_name, i.row_count, i.receipt_count, i.issue_count, i.amount_cents, i.created_at, s.display_name AS created_by_name
    FROM ledger_imports i JOIN staff s ON s.id = i.created_by WHERE i.id = ${importId}`;
  const docs = await db<LedgerImportResult['docs']>`
    SELECT d.id, d.doc_no, d.doc_type, d.doc_date, COALESCE(s.name, p.name, '') AS party, d.amount_cents,
           (SELECT count(*)::int FROM inv_doc_lines l WHERE l.doc_id = d.id) AS line_count
    FROM inv_docs d LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN departments p ON p.id = d.department_id
    WHERE d.ledger_import_id = ${importId} ORDER BY d.doc_date, d.id`;
  return {
    import: {
      ...imp!,
      id: Number(imp!.id),
      rowCount: Number(imp!.rowCount),
      receiptCount: Number(imp!.receiptCount),
      issueCount: Number(imp!.issueCount),
      amountCents: Number(imp!.amountCents),
    },
    docs: docs.map((d) => ({ ...d, id: Number(d.id), amountCents: Number(d.amountCents) })),
    replayed,
  };
}

export async function applyLedgerImport(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<LedgerImportResult> {
  const f = parse(ApplyInput, raw);
  const requestHash = hashRequest({ ...f, clientKey: undefined });
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, f.clientKey);
    const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${f.clientKey}`;
    if (seen) {
      if (seen.opType !== 'ledger_import' || seen.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次导入，请刷新页面后重新选择文件');
      return { id: Number(seen.refId), replayed: true };
    }
    await assertNotFenced(tx, f.clientKey, 'ledger_import', erpOpAbandoned);
    const first = readLedger(f);
    // 同一份文件串行处理：「以前导入过」的核对与写入不会两边都漏看（文件摘要的唯一约束兜底）
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`ledger_import:${first.sha256}`}, 0))`;
    const p = await plan(tx, f, deps.config.timezone);
    if (p.issueCount) {
      const bad = p.rows.filter((x) => x.issues.length);
      throw unprocessable(
        'IMPORT_INVALID',
        `有 ${bad.length} 行要先改好才能导入：${bad
          .slice(0, 3)
          .map((x) => `第 ${x.row} 行 ${x.issues[0]}`)
          .join('；')}`,
        { rows: bad.map((x) => ({ row: x.row, issues: x.issues })) },
      );
    }
    if (p.previous) {
      throw conflict('IMPORT_REPEAT', `这份文件 ${p.previous.createdByName} 已经导入过，同一份文件不能再导入：重复记账会多出、多扣库存`, { importId: p.previous.id });
    }
    const planned = docsOf(p.rows, factorsOf(await tx<Mat[]>`SELECT id, purchase_factor_milli FROM materials WHERE id IN ${tx([...new Set(p.rows.map((x) => x.material!.id))])}`));
    if (planned.length === 0) throw unprocessable('IMPORT_NOTHING', '这份台账里没有入库也没有出库，没有要导入的');
    const receipts = planned.filter((d) => d.kind === 'receipt').length;
    const [imp] = await tx<{ id: number }[]>`
      INSERT INTO ledger_imports (client_key, file_sha256, file_name, row_count, receipt_count, issue_count, amount_cents, created_by)
      VALUES (${f.clientKey}, ${p.sha256}, ${f.fileName}, ${p.rows.length}, ${receipts}, ${planned.length - receipts}, ${p.amountCents}, ${actor.id})
      RETURNING id`;
    const importId = Number(imp!.id);
    // 先按日期取好全部单号，再按 id 升序锁住全部物料（与新建单据的顺序一致：单号计数 → 物料）
    const docNos: string[] = [];
    for (const d of planned) docNos.push(d.kind === 'receipt' ? await nextReceiptNo(tx, d.docDate) : await nextIssueNo(tx, d.docDate));
    const materialIds = [...new Set(p.rows.map((x) => x.material!.id))].sort((a, b) => a - b);
    await tx`SELECT id FROM materials WHERE id IN ${tx(materialIds)} ORDER BY id FOR UPDATE`;
    // 锁住物料以后再算一遍：上面那一遍读物料时还没上锁，期间有人改了档案、结存或参考价，就整份不导
    // 与用户看过的那次预览比（预览摘要随请求带来）：预览以后改过参考价、档案、结存的，整份不导
    const again = await plan(tx, f, deps.config.timezone);
    if (again.digest !== f.previewDigest || again.digest !== p.digest) {
      throw conflict('IMPORT_STALE', '预览以后有物料的档案、参考价或结存变过，这份台账没有导入；请重新预览、核对后再导入');
    }
    // 库位写进物料档案（已经锁着）
    for (const row of p.rows) {
      if (row.location && row.location !== row.locationBefore) await tx`UPDATE materials SET location = ${row.location}, updated_at = now() WHERE id = ${row.material!.id}`;
    }
    const note = `出入库台账导入：${f.fileName}`.slice(0, 200);
    for (const [i, d] of planned.entries()) {
      const body =
        d.kind === 'receipt'
          ? {
              docType: 'receipt' as const,
              docDate: d.docDate,
              note,
              supplierId: d.supplierId!,
              purchaseOrderId: null,
              handler: '',
              direct: true,
              lines: d.lines.map((l) => ({
                materialId: l.materialId,
                poLineId: null,
                deliveredMilli: l.qtyMilli,
                acceptedMilli: l.qtyMilli,
                rejectReason: '',
                priceCents: l.priceCents,
                batchNo: null,
                producedOn: null,
                expiresOn: null,
                note: l.note,
              })),
            }
          : {
              docType: 'issue' as const,
              docDate: d.docDate,
              note,
              departmentId: d.departmentId!,
              handler: d.receiver.slice(0, 32),
              lines: d.lines.map((l) => ({ materialId: l.materialId, qtyMilli: l.qtyMilli, enteredQtyMilli: null, enteredUnit: null, note: l.note })),
            };
      await createLedgerDoc(tx, deps, body, actor, { docNo: docNos[i]!, ledgerImportId: importId, note });
    }
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${f.clientKey}, 'ledger_import', ${requestHash}, ${importId}, ${actor.id})`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'ledger_import',
      targetType: 'ledger_import',
      targetId: importId,
      detail: { fileName: f.fileName, rows: p.rows.length, receipts, issues: planned.length - receipts, amountCents: p.amountCents, sha256: p.sha256 },
      ip,
    });
    return { id: importId, replayed: false };
  });
  return ledgerImportResult(deps.sql, r.id, r.replayed);
}

// ───────────────────────── 模板与导出（同一个版式） ─────────────────────────

interface LedgerSheetRow {
  seq: number | string;
  date: string;
  supplier: string;
  name: string;
  spec: string;
  location: string;
  open: number | null;
  ins: { date: string; qty: number }[];
  outs: { date: string; qty: number; who: string }[];
  close: number | null;
  price: number | null;
  note: string;
}

// 列宽照门店《库管出入库明细及库位表》的「仓库库位表」（店主 2026-11-22：模板以门店给的表格格式为主）
const HEAD_WIDTHS = [5, 11, 12, 20, 11, 9, 11];
/**
 * 表头两行（第 2、3 行）与标题行，入库、出库按组数展开，照门店的表：「入库」一个分组名跨全部入库组，「出库」每组一个分组名；
 * 标题跨到倒数第 4 列，「库管：」占倒数第 3、2 列。tail：库存量、备注之后再加的列（导出加「参考价」）
 */
function ledgerHeader(inSlots: number, outSlots: number, title: string, keeper: string, tail: readonly string[] = []) {
  const style = (name: string): WbCell['style'] => (name === '物料名称' ? 'required' : 'optional');
  const top: (WbCell | null)[] = [];
  const sub: (WbCell | null)[] = [];
  const merges: string[] = [];
  const widths: number[] = [];
  const single = (c: string, width: number) => {
    top.push({ v: c, style: style(c) });
    sub.push(null);
    merges.push(`${colName(top.length - 1)}2:${colName(top.length - 1)}3`);
    widths.push(width);
  };
  for (const [i, c] of LEDGER_COLUMNS.entries()) single(c, HEAD_WIDTHS[i]!);
  const group = (name: string, cols: string[], slots: number, oneLabel: boolean) => {
    for (let s = 0; s < slots; s++) {
      const start = top.length;
      for (const [j, c] of cols.entries()) {
        top.push(j === 0 && (s === 0 || !oneLabel) ? { v: name, style: 'optional' } : null);
        sub.push({ v: c, style: 'optional' });
        widths.push(c === '领料人及部门' ? 11 : c === '日期' ? 8 : 6);
      }
      if (!oneLabel) merges.push(`${colName(start)}2:${colName(top.length - 1)}2`);
    }
    if (oneLabel && slots > 0) merges.push(`${colName(top.length - cols.length * slots)}2:${colName(top.length - 1)}2`);
  };
  group('入库', ['日期', '数量'], inSlots, true);
  group('出库', ['日期', '数量', '领料人及部门'], outSlots, false);
  for (const c of [...LEDGER_TAIL_COLUMNS, ...tail]) single(c, c === '备注' ? 18 : 9);
  const width = top.length;
  const titleRow: (WbCell | null)[] = Array.from({ length: width }, () => null);
  titleRow[0] = { v: title, style: 'title' };
  titleRow[width - 3] = { v: keeper, style: 'note' };
  merges.push(`A1:${colName(width - 4)}1`, `${colName(width - 3)}1:${colName(width - 2)}1`);
  return {
    rows: [
      { height: 31, cells: titleRow },
      { height: 31, cells: top },
      { height: 21, cells: sub },
    ],
    merges,
    widths,
    width,
  };
}

function ledgerBody(rows: LedgerSheetRow[], inSlots: number, outSlots: number) {
  return rows.map((r) => {
    const cells: (WbCell | string | number | null)[] = [r.seq, r.date, r.supplier, r.name, r.spec, r.location, r.open];
    for (let i = 0; i < inSlots; i++) cells.push(r.ins[i]?.date ?? null, r.ins[i]?.qty ?? null);
    for (let i = 0; i < outSlots; i++) cells.push(r.outs[i]?.date ?? null, r.outs[i]?.qty ?? null, r.outs[i]?.who ?? null);
    cells.push(r.close, r.note, r.price);
    return { cells };
  });
}

/**
 * 下载模板（店主 2026-11-22《ERP 需求汇总更新》与附件《库管出入库明细及库位表》）：点「下载模板」直接下载门店给的那份表格——
 * 附件里看得到的两张表合在一个文件里（其余几张是隐藏的、门店自己的数据，不带），照原样：
 *   - 「入库登记表格」：库管手工登记到货用，不导入（店主定）；
 *   - 「仓库库位表」（打开时选中）：一行表头——序号、日期、供应商、物料名称、规格、库位、接手存量，
 *     出库数量 / 日期 / 部门及领料人、出库数量 / 日期 / 领料人及部门、入库、出库数量 / 日期 / 领料人及部门、库存量、交接盘点。导入读这一张。
 * 门店的真实数据（人名等）不带；不另加单价列与说明页：入库单价取物料档案的参考价（表里自己加一列「单价」照样认）。文件名「出入库台账」。
 */
export const LEDGER_TEMPLATE_FILE = '出入库台账.xlsx';

/** 附件「仓库库位表」的一行表头与列宽（「10月14日交接盘点」是那一次的日期，模板里写「交接盘点」） */
const LEDGER_SINGLE_HEAD: [string, number][] = [
  ['序号', 6],
  ['日期', 9],
  ['供应商', 17],
  ['物料名称', 20],
  ['规格', 10],
  ['库位', 9],
  ['接手存量', 11],
  ['出库数量', 9],
  ['日期', 8],
  ['部门及领料人', 12],
  ['出库数量', 9],
  ['日期', 8],
  ['领料人及部门', 14],
  ['入库', 8],
  ['出库数量', 9],
  ['日期', 8],
  ['领料人及部门', 14],
  ['库存量', 9],
  ['交接盘点', 17],
];
const TEMPLATE_ROWS = { ledger: 116, register: 30 } as const;

export async function ledgerTemplate(db: Db): Promise<Buffer> {
  const settings = await loadInventorySettings(db);
  const register: WbSheet = {
    name: '入库登记表格',
    widths: [6, 12, 22, 13, 9, 9, 20, 11],
    rows: [
      { height: 34, cells: [{ v: '入库登记表', style: 'title' }, null, null, null, null, null, null, { v: '库管：', style: 'note' }] },
      { height: 21, cells: ['序号', '日期', '物品名称', '规格型号', '计量单位', '数量', '备注（部门）', '库位'].map((v) => ({ v, style: 'optional' as const })) },
      ...Array.from({ length: TEMPLATE_ROWS.register }, (_, i) => ({ height: 25, cells: [i + 1] })),
    ],
    merges: ['A1:G1'],
  };
  const width = LEDGER_SINGLE_HEAD.length;
  const title: (WbCell | null)[] = Array.from({ length: width }, () => null);
  title[0] = { v: `${settings.scopeName ?? '仓库'}出入库记录`, style: 'title' };
  const ledger: WbSheet = {
    name: '仓库库位表',
    active: true,
    widths: LEDGER_SINGLE_HEAD.map(([, w]) => w),
    freezeRows: 2,
    rows: [
      { height: 31, cells: title },
      { height: 21, cells: LEDGER_SINGLE_HEAD.map(([v]) => ({ v, style: v === '物料名称' ? ('required' as const) : ('optional' as const) })) },
      ...Array.from({ length: TEMPLATE_ROWS.ledger }, (_, i) => ({ height: 25, cells: [i + 1] })),
    ],
    merges: [`A1:${colName(width - 2)}1`],
    validations: [
      { sqref: `D3:D${LEDGER_MAX_ROWS + 2}`, promptTitle: '物料名称（必填）', prompt: '物料档案里的名称（可以写物料编号）；同名的在「规格」写清是哪一个' },
      { sqref: `C3:C${LEDGER_MAX_ROWS + 2}`, promptTitle: '供应商', prompt: '这一行有入库时必填：供应商档案里的名称或编号' },
      { sqref: `N3:N${LEDGER_MAX_ROWS + 2}`, promptTitle: '入库', prompt: '入库数量；入库的日期写在第 2 列「日期」' },
    ],
  };
  return buildWorkbook([register, ledger]);
}

const OUT_LABEL: Record<string, string> = {
  direct_use: '总仓直接耗用',
  damage: '报损',
  supplier_return: '退供应商',
  transfer_out: '调出',
  count_adjust: '盘亏',
  void: '冲销',
};

/** 导出台账：总仓一个月的出入库，与模板同一个版式（标题带「系统导出」，导入时认出来拒绝）；入库、出库按日期（与去向）合并，组数不够就往后加 */
export async function ledgerExport(db: Db, month: string): Promise<{ buf: Buffer; fileName: string }> {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const settings = await loadInventorySettings(db);
  const [central] = await db<{ id: number }[]>`SELECT id FROM warehouses WHERE kind = 'central' ORDER BY id LIMIT 1`;
  const wh = Number(central!.id);
  const mats = await db<{ id: number; name: string; specification: string; location: string; refPriceCents: number | null; open: number; close: number }[]>`
    SELECT m.id, m.name, m.specification, m.location, m.ref_price_cents,
           COALESCE((SELECT sum(qty_delta_milli) FROM stock_moves s WHERE s.material_id = m.id AND s.warehouse_id = ${wh} AND s.doc_date < ${start}), 0)::bigint AS open,
           COALESCE((SELECT sum(qty_delta_milli) FROM stock_moves s WHERE s.material_id = m.id AND s.warehouse_id = ${wh} AND s.doc_date < ${next}), 0)::bigint AS close
    FROM materials m WHERE m.tracked ORDER BY m.category, m.code`;
  const moves = await db<{ materialId: number; moveType: string; docDate: string; delta: number; docType: string; deptName: string | null; handler: string | null; supplierName: string | null }[]>`
    SELECT s.material_id, s.move_type, s.doc_date, sum(s.qty_delta_milli)::bigint AS delta, d.doc_type, p.name AS dept_name, d.handler, sp.name AS supplier_name
    FROM stock_moves s JOIN inv_docs d ON d.id = s.doc_id
    LEFT JOIN departments p ON p.id = d.department_id LEFT JOIN suppliers sp ON sp.id = d.supplier_id
    WHERE s.warehouse_id = ${wh} AND s.doc_date >= ${start} AND s.doc_date < ${next}
    GROUP BY s.material_id, s.move_type, s.doc_date, d.doc_type, p.name, d.handler, sp.name, s.qty_delta_milli > 0
    ORDER BY s.doc_date, s.material_id`;
  const byMat = new Map<number, (typeof moves)[number][]>();
  for (const mv of moves) byMat.set(Number(mv.materialId), [...(byMat.get(Number(mv.materialId)) ?? []), mv]);
  const rows: LedgerSheetRow[] = [];
  for (const mt of mats) {
    const list = byMat.get(Number(mt.id)) ?? [];
    const open = Number(mt.open);
    const close = Number(mt.close);
    if (!list.length && open === 0 && close === 0) continue;
    const ins = new Map<string, number>();
    const outs = new Map<string, { date: string; qty: number; who: string }>();
    const suppliers = new Set<string>();
    for (const mv of list) {
      const delta = Number(mv.delta);
      const date = String(mv.docDate).slice(0, 10);
      if (delta > 0) {
        ins.set(date, (ins.get(date) ?? 0) + delta);
        if (mv.supplierName) suppliers.add(mv.supplierName);
      } else {
        const who = mv.moveType === 'issue' ? [mv.deptName, mv.handler && mv.handler !== mv.deptName ? mv.handler : ''].filter(Boolean).join(' ') : (OUT_LABEL[mv.moveType] ?? mv.moveType);
        const key = `${date}|${who}`;
        const had = outs.get(key);
        if (had) had.qty += -delta;
        else outs.set(key, { date, qty: -delta, who });
      }
    }
    rows.push({
      seq: rows.length + 1,
      date: '',
      supplier: [...suppliers].join('、'),
      name: mt.name,
      spec: mt.specification,
      location: mt.location,
      open: open / 1000,
      ins: [...ins.entries()].map(([date, qty]) => ({ date, qty: qty / 1000 })),
      outs: [...outs.values()].map((o) => ({ ...o, qty: o.qty / 1000 })),
      close: close / 1000,
      price: mt.refPriceCents !== null ? Number(mt.refPriceCents) / 100 : null,
      note: '',
    });
  }
  const inSlots = Math.max(LEDGER_IN_SLOTS, ...rows.map((r) => r.ins.length));
  const outSlots = Math.max(LEDGER_OUT_SLOTS, ...rows.map((r) => r.outs.length));
  const title = `${settings.scopeName ?? '仓库'}出入库记录（${y}年${m}月 · ${LEDGER_EXPORT_MARK}，只用来对账）`;
  const head = ledgerHeader(inSlots, outSlots, title, '库管：', ['参考价']);
  const sheet: WbSheet = { name: '仓库库位表', active: true, widths: head.widths, freezeRows: 3, rows: [...head.rows, ...ledgerBody(rows, inSlots, outSlots)], merges: head.merges };
  return { buf: buildWorkbook([sheet]), fileName: `出入库台账-${month}.xlsx` };
}

export function registerLedgerImportRoutes(app: FastifyInstance, deps: Deps) {
  const bodyLimit = 4_000_000;
  const operate = guard('inventory.operate');
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  app.get('/api/inventory/ledger/template', { preHandler: operate }, async (_req, reply) => {
    const buf = await ledgerTemplate(deps.sql);
    attachment(reply, LEDGER_TEMPLATE_FILE, XLSX);
    return reply.send(buf);
  });
  app.get('/api/inventory/ledger/export', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const { month } = parse(ExportQuery, req.query);
    // 期初期末与明细在同一个只读快照里取，营业中导出也对得上
    const { buf, fileName } = await readSnapshot(deps.sql, (tx) => ledgerExport(tx, month));
    attachment(reply, fileName, XLSX);
    return reply.send(buf);
  });
  app.post('/api/inventory/ledger/import/preview', { preHandler: operate, bodyLimit }, async (req) => previewLedgerImport(deps, req.body));
  app.post('/api/inventory/ledger/import', { preHandler: operate, bodyLimit }, async (req, reply) => {
    const r = await applyLedgerImport(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
  app.get('/api/inventory/ledger/imports/:id', { preHandler: guard('inventory.read') }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    return ledgerImportResult(deps.sql, id, false);
  });
}
