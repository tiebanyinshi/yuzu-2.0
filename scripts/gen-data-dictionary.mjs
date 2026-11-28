// 数据字典生成（8.1.47，数据库评估 docs/DB_REVIEW_V8147.md 第 6 节）：从迁移跑完的库里读表、列、外键与库内注释（COMMENT ON），写成 docs/DATA_DICTIONARY.md。
// 说明的唯一来源是库内注释：改表的迁移里同时写 COMMENT ON，再重新生成，不手改生成的文档。
// tests/schema-health.test.ts 在迁移跑完的测试库上重新生成一遍，与仓库里的不一样就失败（提示照下面重新生成）。
//
//   DATABASE_URL=postgres://…/一个只跑过迁移的空库 node scripts/gen-data-dictionary.mjs
//   （本机：createdb yuzu_dict && DATABASE_URL=… npm run migrate && DATABASE_URL=… node scripts/gen-data-dictionary.mjs）

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DICTIONARY_PATH = 'docs/DATA_DICTIONARY.md';

/** 表名前缀 → 分组（按出现顺序匹配；没匹配上的进「核心与其他」） */
export const GROUPS = [
  ['gf_', '业财法审批（gf_）'],
  ['oa_', '办公 OA（oa_）'],
  ['mp_', '小程序（mp_，小程序线）'],
  ['staffmp_', '员工小程序（staffmp_，员工小程序线）'],
  ['canteen_', '员工食堂（canteen_）'],
  ['concierge_', '客户关系（concierge_）'],
  ['price_catalog_', '价目表（price_catalog_）'],
  ['training_', '员工培训（training_）'],
  ['mall_', '采购商城（mall_）'],
  ['legacy_', '旧系统导入（legacy_）'],
  ['archived_', '归档（archived_）'],
];
const OTHER = '核心与其他';

const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();

/** 读库生成 Markdown；sql 是 postgres.js 的连接（字段名按原样，不做驼峰转换的查询里只用别名） */
export async function renderDictionary(sql) {
  const tables = await sql.unsafe(`
    SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    ORDER BY c.relname COLLATE "C"`);
  const columns = await sql.unsafe(`
    SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
           pg_get_expr(d.adbin, d.adrelid) AS def, col_description(c.oid, a.attnum) AS comment, a.attidentity AS ident,
           (SELECT string_agg(f.confrelid::regclass::text, ', ' ORDER BY f.confrelid::regclass::text)
              FROM pg_constraint f WHERE f.contype = 'f' AND f.conrelid = c.oid AND a.attnum = ANY (f.conkey)) AS refs,
           EXISTS (SELECT 1 FROM pg_constraint p WHERE p.contype = 'p' AND p.conrelid = c.oid AND a.attnum = ANY (p.conkey)) AS pk
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    ORDER BY c.relname COLLATE "C", a.attnum`);
  const byTable = new Map();
  for (const c of columns) {
    if (!byTable.has(c.tbl)) byTable.set(c.tbl, []);
    byTable.get(c.tbl).push(c);
  }
  const groupOf = (name) => GROUPS.find(([p]) => name.startsWith(p))?.[1] ?? OTHER;
  const grouped = new Map([[OTHER, []], ...GROUPS.map(([, g]) => [g, []])]);
  for (const t of tables) grouped.get(groupOf(t.name)).push(t);

  const out = [];
  out.push('# 数据字典');
  out.push('');
  out.push('> 由 `scripts/gen-data-dictionary.mjs` 从迁移跑完的库生成，**不要手改**。说明取自库内注释（`COMMENT ON`，迁移 `481` 起），');
  out.push('> 改表的迁移里同时写注释，再按脚本开头的命令重新生成；`tests/schema-health.test.ts` 核对这份文档与库一致。评估与规则见 `docs/DB_REVIEW_V8147.md`。');
  out.push('');
  out.push('通用约定：金额一律整数「分」（`*_cents`、`amount`、`price` 等整数列）；时刻一律 `timestamptz`；营业日用 `date`；');
  out.push('「只追加」的表（账本、流水、审批动作、归档表）有触发器拒绝改删，改错走冲正或作废登记。');
  out.push('列表里「键」：`PK` 主键；「引用」是外键指向的表。');
  out.push('');
  out.push(`共 ${tables.length} 张表、${columns.length} 列。`);
  out.push('');
  out.push('## 目录');
  out.push('');
  for (const [g, list] of grouped) {
    if (!list.length) continue;
    out.push(`- **${g}**（${list.length}）：${list.map((t) => `[${t.name}](#${t.name})`).join(' · ')}`);
  }
  for (const [g, list] of grouped) {
    if (!list.length) continue;
    out.push('');
    out.push(`## ${g}`);
    for (const t of list) {
      out.push('');
      out.push(`### ${t.name}`);
      out.push('');
      if (t.comment) {
        out.push(cell(t.comment));
        out.push('');
      }
      out.push('| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |');
      out.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const c of byTable.get(t.name) ?? []) {
        const def = c.ident ? (c.ident === 'a' ? 'identity always' : 'identity') : (c.def ?? '');
        out.push(`| ${c.col} | ${cell(c.type)} | ${c.pk ? 'PK' : ''} | ${c.notnull ? '' : '是'} | ${cell(def)} | ${cell(c.refs)} | ${cell(c.comment)} |`);
      }
    }
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('要设 DATABASE_URL（一个只跑过迁移的空库）');
    process.exit(1);
  }
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const md = await renderDictionary(sql);
    const root = resolve(fileURLToPath(import.meta.url), '../..');
    writeFileSync(resolve(root, DICTIONARY_PATH), md);
    console.log(`已写 ${DICTIONARY_PATH}（${md.length} 字符）`);
  } finally {
    await sql.end();
  }
}
